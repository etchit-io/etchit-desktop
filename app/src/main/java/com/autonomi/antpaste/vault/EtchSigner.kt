package com.autonomi.antpaste.vault

import android.util.Log
import com.autonomi.antpaste.BuildConfig
import com.autonomi.antpaste.util.shortMessage
import com.autonomi.antpaste.wallet.Erc20
import com.autonomi.antpaste.wallet.EvmRpc
import com.autonomi.antpaste.wallet.SessionState
import com.autonomi.antpaste.wallet.WalletSession
import com.autonomi.antpaste.wallet.WalletSigner
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import uniffi.ant_ffi.Client
import java.math.BigInteger

// Split into prepare() + signAndFinalize() so a wallet failure can retry signing
// without re-running the multi-minute quote collection.
class EtchSigner(
    private val nativeClient: Client,
    private val walletSession: WalletSession,
    private val walletSigner: WalletSigner,
    private val evmRpc: EvmRpc,
) {

    companion object {
        // 20 ANT in atto.
        val SESSION_BUDGET_ATTO: BigInteger = BigInteger.TEN.pow(18) * BigInteger.valueOf(20)
    }

    sealed class EtchResult {
        data class Public(val address: String, val chunksStored: Long) : EtchResult()
        data class Private(val dataMapHex: String, val chunksStored: Long) : EtchResult()
    }

    data class PreparedEtch(
        val uploadId: String,
        val payments: List<uniffi.ant_ffi.PaymentEntry>,
        val totalAmountStr: String,
        val totalAtto: BigInteger,
        val publicAddress: String?,
        val privateDataMap: String?,
        val isPrivate: Boolean,
        val dataSize: Int,
        val createdAtMs: Long = System.currentTimeMillis(),
    )

    suspend fun prepare(
        data: ByteArray,
        isPrivate: Boolean,
        onProgress: (Progress) -> Unit,
    ): PreparedEtch {
        onProgress(Progress.CollectingQuotes)

        val uploadId: String
        val payments: List<uniffi.ant_ffi.PaymentEntry>
        val totalAmountStr: String
        val publicAddress: String?
        val privateDataMap: String?

        if (isPrivate) {
            val prepared = nativeClient.prepareDataUpload(data)
            uploadId = prepared.uploadId
            payments = prepared.payments
            totalAmountStr = prepared.totalAmount
            publicAddress = null
            privateDataMap = prepared.dataMap
            Log.i("ant-paste", "EtchSigner: prepared PRIVATE uploadId=$uploadId payments=${payments.size}")
        } else {
            val prepared = nativeClient.preparePublicUpload(data)
            uploadId = prepared.uploadId
            payments = prepared.payments
            totalAmountStr = prepared.totalAmount
            publicAddress = prepared.dataMapAddress
            privateDataMap = null
            Log.i("ant-paste", "EtchSigner: prepared PUBLIC uploadId=$uploadId payments=${payments.size}")
        }

        // Emit before returning so caller can fire a notification before the cost prompt.
        onProgress(Progress.QuotesReady)

        return PreparedEtch(
            uploadId = uploadId,
            payments = payments,
            totalAmountStr = totalAmountStr,
            totalAtto = BigInteger(totalAmountStr),
            publicAddress = publicAddress,
            privateDataMap = privateDataMap,
            isPrivate = isPrivate,
            dataSize = data.size,
        )
    }

    suspend fun readAllowance(userAddress: String): BigInteger {
        val allowanceReturn = try {
            evmRpc.ethCall(
                to = BuildConfig.ANT_TOKEN_ADDRESS,
                data = Erc20.encodeAllowance(userAddress, BuildConfig.VAULT_ADDRESS),
            )
        } catch (e: Exception) {
            Log.w("ant-paste", "EtchSigner: allowance read failed, assuming 0: ${e.shortMessage()}")
            ByteArray(0)
        }
        return if (allowanceReturn.size == 32) Erc20.decodeUint256(allowanceReturn) else BigInteger.ZERO
    }

    // previouslyPaidTxHash short-circuits the wallet flow when a finalize-failure
    // retry is resuming against a payForQuotes that already landed on-chain.
    suspend fun signAndFinalize(
        prepared: PreparedEtch,
        approveBudget: BigInteger,
        onProgress: (Progress) -> Unit,
        previouslyPaidTxHash: String? = null,
    ): EtchResult {
        if (previouslyPaidTxHash != null) {
            Log.i(
                "ant-paste",
                "EtchSigner: resuming with previously paid tx $previouslyPaidTxHash — skipping wallet flow",
            )
            return finalizeAgainst(prepared, previouslyPaidTxHash, recovered = true, onProgress = onProgress)
        }

        val session = walletSession.state.value as? SessionState.Connected
            ?: throw IllegalStateException("Wallet disconnected mid-etch")
        val userAddress = session.address
        val targetChain = BuildConfig.CHAIN_ID
        val signingChainCaip = "eip155:$targetChain"

        onProgress(Progress.CheckingAllowance)
        val allowance = readAllowance(userAddress)
        val needsApproval = allowance < prepared.totalAtto
        Log.i(
            "ant-paste",
            "EtchSigner: allowance=$allowance need=${prepared.totalAtto} needsApproval=$needsApproval"
        )

        var expectedAllowance = allowance

        if (session.chainId != signingChainCaip) {
            onProgress(Progress.SwitchingChain)
            try {
                walletCall("switch chain") {
                    walletSigner.switchChain(
                        sessionChainId = session.chainId,
                        targetChainId = targetChain,
                    )
                }
                Log.i("ant-paste", "EtchSigner: wallet_switchEthereumChain → $targetChain ok")
            } catch (e: Exception) {
                Log.w("ant-paste", "EtchSigner: switchChain failed, continuing: ${e.shortMessage()}")
            }
        } else {
            Log.i("ant-paste", "EtchSigner: already on chain $signingChainCaip, skipping switch")
        }

        if (needsApproval) {
            onProgress(Progress.ApprovingToken)
            val approveAmount = approveBudget.max(prepared.totalAtto)
            val approveHash = walletCall("approve token") {
                walletSigner.sendTransaction(
                    chainId = signingChainCaip,
                    from = userAddress,
                    to = BuildConfig.ANT_TOKEN_ADDRESS,
                    data = Erc20.encodeApprove(BuildConfig.VAULT_ADDRESS, approveAmount),
                )
            }
            Log.i("ant-paste", "EtchSigner: approve tx sent $approveHash (budget=$approveAmount)")
            onProgress(Progress.WaitingForApprove(approveHash))
            val receipt = evmRpc.waitForReceipt(approveHash)
            if (receipt.status != EvmRpc.ReceiptStatus.SUCCESS) {
                throw RuntimeException("ANT approve reverted (tx $approveHash)")
            }
            Log.i("ant-paste", "EtchSigner: approve confirmed block=${receipt.blockNumber}")
            expectedAllowance = approveAmount
        }

        // Ghost-payment guard: MetaMask code=1 can return an error even when the
        // tx broadcast successfully. If allowance dropped by the etch amount since
        // baseline, a prior attempt paid — finalize against that tx instead of paying twice.
        val allowanceNow = readAllowance(userAddress)
        val drop = expectedAllowance - allowanceNow
        if (drop >= prepared.totalAtto) {
            Log.w(
                "ant-paste",
                "EtchSigner: ghost payment detected — allowance dropped by $drop since baseline=$expectedAllowance"
            )
            val ghostHash = evmRpc.findRecentTxFromUserToContract(
                userAddress = userAddress,
                contractAddress = BuildConfig.VAULT_ADDRESS,
                tokenAddress = BuildConfig.ANT_TOKEN_ADDRESS,
            )
            if (ghostHash == null) {
                throw RuntimeException(
                    "Previous payment landed on-chain but its tx hash couldn't be " +
                        "found in recent blocks. Try again in a minute, or finalize manually."
                )
            }
            Log.i("ant-paste", "EtchSigner: recovered ghost tx $ghostHash — finalizing against it")
            onProgress(Progress.PaidAwaitingFinalize(ghostHash))
            return finalizeAgainst(prepared, ghostHash, recovered = true, onProgress = onProgress)
        }

        onProgress(Progress.SigningPayment)
        val vaultPayments = prepared.payments.map { entry ->
            PaymentVault.Payment(
                rewardsAddress = entry.rewardsAddress,
                amount = BigInteger(entry.amount),
                quoteHash = entry.quoteHash,
            )
        }
        val vaultCalldata = PaymentVault.encodeBatchPayment(vaultPayments)
        val payHash = walletCall("pay vault") {
            walletSigner.sendTransaction(
                chainId = signingChainCaip,
                from = userAddress,
                to = BuildConfig.VAULT_ADDRESS,
                data = vaultCalldata,
            )
        }
        Log.i("ant-paste", "EtchSigner: payForQuotes tx sent $payHash")
        onProgress(Progress.WaitingForPayment(payHash))
        val payReceipt = evmRpc.waitForReceipt(payHash)
        if (payReceipt.status != EvmRpc.ReceiptStatus.SUCCESS) {
            throw RuntimeException("payForQuotes reverted (tx $payHash)")
        }
        Log.i("ant-paste", "EtchSigner: payForQuotes confirmed block=${payReceipt.blockNumber}")

        // Surface hash before finalize so retry can re-finalize against it instead of re-paying.
        onProgress(Progress.PaidAwaitingFinalize(payHash))

        return finalizeAgainst(prepared, payHash, recovered = false, onProgress = onProgress)
    }

    private suspend fun finalizeAgainst(
        prepared: PreparedEtch,
        payHash: String,
        recovered: Boolean,
        onProgress: (Progress) -> Unit,
    ): EtchResult {
        onProgress(Progress.FinalizingUpload)
        val tag = if (recovered) " (recovered)" else ""
        val txHashMap: Map<String, String> = prepared.payments.associate { it.quoteHash to payHash }
        return if (prepared.isPrivate) {
            val result = nativeClient.finalizeUpload(prepared.uploadId, txHashMap)
            Log.i("ant-paste", "EtchSigner: finalized PRIVATE$tag chunks=${result.chunksStored}")
            EtchResult.Private(prepared.privateDataMap!!, result.chunksStored.toLong())
        } else {
            val result = nativeClient.finalizePublicUpload(prepared.uploadId, txHashMap)
            Log.i("ant-paste", "EtchSigner: finalized PUBLIC$tag address=${result.address}")
            EtchResult.Public(result.address, result.chunksStored.toLong())
        }
    }

    suspend fun etch(
        data: ByteArray,
        private: Boolean = false,
        costPrompt: suspend (totalAtto: String, dataSize: Int, needsApproval: Boolean) -> BigInteger?,
        onProgress: (Progress) -> Unit,
        onPrepared: ((PreparedEtch) -> Unit)? = null,
    ): EtchResult? {
        val prepared = prepare(data, private, onProgress)
        onPrepared?.invoke(prepared)

        val session = walletSession.state.value as? SessionState.Connected
            ?: throw IllegalStateException("Wallet disconnected mid-etch")
        val allowance = readAllowance(session.address)
        val needsApproval = allowance < prepared.totalAtto

        val approveBudget = costPrompt(prepared.totalAmountStr, prepared.dataSize, needsApproval)
            ?: run {
                Log.i("ant-paste", "EtchSigner: cancelled at cost prompt")
                return null
            }

        return signAndFinalize(prepared, approveBudget, onProgress)
    }

    sealed class Progress {
        data object CollectingQuotes : Progress()
        data object QuotesReady : Progress()
        data object SwitchingChain : Progress()
        data object CheckingAllowance : Progress()
        data object ApprovingToken : Progress()
        data class WaitingForApprove(val txHash: String) : Progress()
        data object SigningPayment : Progress()
        data class WaitingForPayment(val txHash: String) : Progress()
        // Persist txHash so a finalize-failure retry can re-finalize, not re-pay.
        data class PaidAwaitingFinalize(val txHash: String) : Progress()
        data object FinalizingUpload : Progress()
    }
}

// Backstop in case AppKit drops a request without firing onRequestExpired.
private suspend fun <T> walletCall(label: String, block: suspend () -> T): T {
    val t0 = System.currentTimeMillis()
    Log.i("ant-paste", "EtchSigner: walletCall($label) start")
    return try {
        val result = withTimeout(60_000) { block() }
        Log.i("ant-paste", "EtchSigner: walletCall($label) ok after ${System.currentTimeMillis() - t0}ms")
        result
    } catch (e: TimeoutCancellationException) {
        Log.w("ant-paste", "EtchSigner: walletCall($label) TIMEOUT after ${System.currentTimeMillis() - t0}ms")
        throw RuntimeException("Wallet didn't respond within 60s ($label) — try again")
    }
}
