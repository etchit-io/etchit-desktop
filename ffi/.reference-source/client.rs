use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::Mutex;
use zeroize::Zeroize;

use ant_core::data::{
    Client as CoreClient, ClientConfig, CoreNodeConfig, ExternalPaymentInfo, MultiAddr, NodeMode,
    P2PNode, PaymentIntent, PreparedUpload, compute_address,
};

use crate::data::{format_payment_mode, parse_payment_mode};
use crate::{
    ChunkPutResult, ClientError, DataPutPrivateResult, DataPutPublicResult,
    FinalizeUploadResult, FilePutPublicResult, PaymentEntry, PrepareUploadResult,
    PreparePublicUploadResult, PublicUploadResult,
};

/// Autonomi network client (wraps ant-core Client).
///
/// Provides direct access to the Autonomi network without needing
/// an antd daemon. Suitable for mobile apps (Android/iOS).
#[derive(uniffi::Object)]
pub struct Client {
    inner: CoreClient,
    /// Pending prepared uploads (external signer flow).
    pending_uploads: Mutex<HashMap<String, PreparedUpload>>,
}

#[uniffi::export(async_runtime = "tokio")]
impl Client {
    /// Connect to a local test network.
    #[uniffi::constructor]
    pub async fn connect_local() -> Result<Arc<Self>, ClientError> {
        let builder = CoreNodeConfig::builder()
            .mode(NodeMode::Client)
            .port(0)
            .local(true)
            .allow_loopback(true)
            .ipv6(false);

        #[allow(unused_mut)]
        let mut config = builder
            .build()
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        #[cfg(feature = "testnet-patches")]
        {
            // The Autonomi testnet runs many nodes on a single Digital Ocean
            // /24 (47.207.67.x), so default close-group diversity limits
            // (5 per /24) reject most peers and quote collection fails.
            // `testnet()` relaxes per-IP and per-subnet caps to `usize::MAX`.
            config.diversity_config = Some(ant_node::core::IPDiversityConfig::testnet());
        }

        let node = P2PNode::new(config)
            .await
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        node.start()
            .await
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        let client = CoreClient::from_node(Arc::new(node), ClientConfig::default());

        Ok(Arc::new(Self { inner: client, pending_uploads: Mutex::new(HashMap::new()) }))
    }

    /// Connect to the network using explicit bootstrap peers.
    #[uniffi::constructor]
    pub async fn connect(peers: Vec<String>) -> Result<Arc<Self>, ClientError> {
        #[allow(unused_mut)]
        let mut builder = CoreNodeConfig::builder()
            .mode(NodeMode::Client)
            .port(0);

        #[cfg(feature = "testnet-patches")]
        {
            builder = builder.ipv6(false).allow_loopback(true);
        }

        for peer_str in &peers {
            let addr: MultiAddr = peer_str
                .parse()
                .map_err(|e| ClientError::InitializationFailed {
                    reason: format!("invalid peer address {peer_str}: {e}"),
                })?;
            builder = builder.bootstrap_peer(addr);
        }

        #[allow(unused_mut)]
        let mut config = builder
            .build()
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        #[cfg(feature = "testnet-patches")]
        {
            // The Autonomi testnet runs many nodes on a single Digital Ocean
            // /24 (47.207.67.x), so default close-group diversity limits
            // (5 per /24) reject most peers and quote collection fails.
            // `testnet()` relaxes per-IP and per-subnet caps to `usize::MAX`.
            config.diversity_config = Some(ant_node::core::IPDiversityConfig::testnet());
        }

        let node = P2PNode::new(config)
            .await
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        let node = Arc::new(node);
        start_node_with_warmup(node.clone()).await?;

        let client = CoreClient::from_node(node, mobile_client_config());

        Ok(Arc::new(Self { inner: client, pending_uploads: Mutex::new(HashMap::new()) }))
    }

    /// Connect to the network with a wallet configured for write operations.
    ///
    /// Takes the wallet private key and EVM network details directly,
    /// since the wallet must be constructed fresh for ownership transfer.
    #[uniffi::constructor]
    pub async fn connect_with_wallet(
        peers: Vec<String>,
        mut private_key: String,
        rpc_url: String,
        payment_token_address: String,
        payment_vault_address: String,
    ) -> Result<Arc<Self>, ClientError> {
        #[allow(unused_mut)]
        let mut builder = CoreNodeConfig::builder()
            .mode(NodeMode::Client)
            .port(0);

        #[cfg(feature = "testnet-patches")]
        {
            builder = builder.ipv6(false).allow_loopback(true);
        }

        for peer_str in &peers {
            let addr: MultiAddr = peer_str
                .parse()
                .map_err(|e| ClientError::InitializationFailed {
                    reason: format!("invalid peer address {peer_str}: {e}"),
                })?;
            builder = builder.bootstrap_peer(addr);
        }

        #[allow(unused_mut)]
        let mut config = builder
            .build()
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        #[cfg(feature = "testnet-patches")]
        {
            // The Autonomi testnet runs many nodes on a single Digital Ocean
            // /24 (47.207.67.x), so default close-group diversity limits
            // (5 per /24) reject most peers and quote collection fails.
            // `testnet()` relaxes per-IP and per-subnet caps to `usize::MAX`.
            config.diversity_config = Some(ant_node::core::IPDiversityConfig::testnet());
        }

        let node = P2PNode::new(config)
            .await
            .map_err(|e| ClientError::InitializationFailed {
                reason: e.to_string(),
            })?;

        let node = Arc::new(node);
        start_node_with_warmup(node.clone()).await?;

        let network = evmlib::Network::new_custom(
            &rpc_url,
            &payment_token_address,
            &payment_vault_address,
        );
        let result = evmlib::wallet::Wallet::new_from_private_key(network, &private_key);
        // Clear the private key from memory as soon as possible
        private_key.zeroize();
        let wallet = result.map_err(|e| ClientError::InitializationFailed {
                reason: format!("failed to create wallet: {e}"),
            })?;

        let client =
            CoreClient::from_node(node, mobile_client_config()).with_wallet(wallet);

        Ok(Arc::new(Self { inner: client, pending_uploads: Mutex::new(HashMap::new()) }))
    }

    // ===== Chunk Operations =====

    /// Store a chunk on the network.
    pub async fn chunk_put(&self, data: Vec<u8>) -> Result<ChunkPutResult, ClientError> {
        let address = self.inner.chunk_put(Bytes::from(data)).await?;
        Ok(ChunkPutResult {
            address: hex::encode(address),
        })
    }

    /// Retrieve a chunk by hex-encoded address.
    pub async fn chunk_get(&self, address_hex: String) -> Result<Vec<u8>, ClientError> {
        let address = hex_to_address(&address_hex)?;
        let chunk = self
            .inner
            .chunk_get(&address)
            .await?
            .ok_or_else(|| ClientError::NotFound {
                reason: format!("chunk {address_hex} not found"),
            })?;
        Ok(chunk.content.to_vec())
    }

    /// Check if a chunk exists on the network.
    pub async fn chunk_exists(&self, address_hex: String) -> Result<bool, ClientError> {
        let address = hex_to_address(&address_hex)?;
        Ok(self.inner.chunk_exists(&address).await?)
    }

    /// Number of peers currently connected to the underlying P2P node.
    pub async fn peer_count(&self) -> u64 {
        self.inner.network().connected_peers().await.len() as u64
    }

    // ===== Data Operations =====

    /// Upload public data. Returns the address of the stored data map.
    pub async fn data_put_public(
        &self,
        data: Vec<u8>,
        payment_mode: String,
    ) -> Result<DataPutPublicResult, ClientError> {
        let mode = parse_payment_mode(&payment_mode).map_err(|e| ClientError::InvalidInput {
            reason: e,
        })?;

        let result = self
            .inner
            .data_upload_with_mode(Bytes::from(data), mode)
            .await?;

        let address = self.inner.data_map_store(&result.data_map).await?;

        Ok(DataPutPublicResult {
            address: hex::encode(address),
            chunks_stored: result.chunks_stored as u64,
            payment_mode_used: format_payment_mode(result.payment_mode_used),
        })
    }

    /// Retrieve public data by hex-encoded address.
    pub async fn data_get_public(&self, address_hex: String) -> Result<Vec<u8>, ClientError> {
        let address = hex_to_address(&address_hex)?;
        let data_map = self.inner.data_map_fetch(&address).await?;
        let content = self.inner.data_download(&data_map).await?;
        Ok(content.to_vec())
    }

    /// Upload private data. Returns the serialized data map (hex).
    pub async fn data_put_private(
        &self,
        data: Vec<u8>,
        payment_mode: String,
    ) -> Result<DataPutPrivateResult, ClientError> {
        let mode = parse_payment_mode(&payment_mode).map_err(|e| ClientError::InvalidInput {
            reason: e,
        })?;

        let result = self
            .inner
            .data_upload_with_mode(Bytes::from(data), mode)
            .await?;

        let data_map_bytes = rmp_serde::to_vec(&result.data_map).map_err(|e| {
            ClientError::InternalError {
                reason: format!("failed to serialize data map: {e}"),
            }
        })?;

        Ok(DataPutPrivateResult {
            data_map: hex::encode(data_map_bytes),
            chunks_stored: result.chunks_stored as u64,
            payment_mode_used: format_payment_mode(result.payment_mode_used),
        })
    }

    /// Retrieve private data using a hex-encoded data map.
    pub async fn data_get_private(&self, data_map_hex: String) -> Result<Vec<u8>, ClientError> {
        // Reject unreasonably large hex input (20 MB hex = 10 MB decoded)
        const MAX_HEX_INPUT: usize = 20 * 1024 * 1024;
        if data_map_hex.len() > MAX_HEX_INPUT {
            return Err(ClientError::InvalidInput {
                reason: format!(
                    "data map hex too large: {} bytes (max {})",
                    data_map_hex.len(),
                    MAX_HEX_INPUT
                ),
            });
        }
        let data_map_bytes =
            hex::decode(&data_map_hex).map_err(|e| ClientError::InvalidInput {
                reason: format!("invalid hex: {e}"),
            })?;
        let data_map: ant_core::data::DataMap =
            rmp_serde::from_slice(&data_map_bytes).map_err(|e| ClientError::InvalidInput {
                reason: format!("invalid data map: {e}"),
            })?;
        let content = self.inner.data_download(&data_map).await?;
        Ok(content.to_vec())
    }

    // ===== File Operations =====

    /// Upload a file from disk (public). Returns the address.
    pub async fn file_upload_public(
        &self,
        path: String,
        payment_mode: String,
    ) -> Result<FilePutPublicResult, ClientError> {
        let mode = parse_payment_mode(&payment_mode).map_err(|e| ClientError::InvalidInput {
            reason: e,
        })?;
        let file_path = PathBuf::from(&path);

        let result = self
            .inner
            .file_upload_with_mode(&file_path, mode)
            .await?;

        let address = self.inner.data_map_store(&result.data_map).await?;

        Ok(FilePutPublicResult {
            address: hex::encode(address),
        })
    }

    /// Download a file to disk by hex-encoded address.
    pub async fn file_download_public(
        &self,
        address_hex: String,
        dest_path: String,
    ) -> Result<(), ClientError> {
        let address = hex_to_address(&address_hex)?;
        let data_map = self.inner.data_map_fetch(&address).await?;
        let dest = PathBuf::from(&dest_path);
        self.inner
            .file_download(&data_map, &dest)
            .await
            .map_err(|e| ClientError::NetworkError {
                reason: e.to_string(),
            })?;
        Ok(())
    }

    // ===== External Signer Operations =====

    /// Prepare a private data upload for external signing.
    /// Encrypts data, collects quotes, returns payment details and the
    /// serialized data-map (which the caller keeps secret for later retrieval).
    /// Call `finalize_upload` with tx hashes after signing externally.
    pub async fn prepare_data_upload(
        &self,
        data: Vec<u8>,
    ) -> Result<PrepareUploadResult, ClientError> {
        let prepared = self.inner.data_prepare_upload(Bytes::from(data)).await?;
        let intent = wave_batch_payment_intent(&prepared)?;

        let payments = payment_entries(intent);
        let total_amount = intent.total_amount.to_string();

        let data_map_bytes = rmp_serde::to_vec(&prepared.data_map).map_err(|e| {
            ClientError::InternalError { reason: format!("serialize data map: {e}") }
        })?;
        let data_map = hex::encode(data_map_bytes);

        let upload_id = self.store_pending(prepared).await;

        Ok(PrepareUploadResult { upload_id, payments, total_amount, data_map })
    }

    /// Prepare a private file upload for external signing.
    pub async fn prepare_file_upload(
        &self,
        path: String,
    ) -> Result<PrepareUploadResult, ClientError> {
        let file_path = PathBuf::from(&path);
        let prepared = self.inner.file_prepare_upload(&file_path).await?;
        let intent = wave_batch_payment_intent(&prepared)?;

        let payments = payment_entries(intent);
        let total_amount = intent.total_amount.to_string();

        let data_map_bytes = rmp_serde::to_vec(&prepared.data_map).map_err(|e| {
            ClientError::InternalError { reason: format!("serialize data map: {e}") }
        })?;
        let data_map = hex::encode(data_map_bytes);

        let upload_id = self.store_pending(prepared).await;

        Ok(PrepareUploadResult { upload_id, payments, total_amount, data_map })
    }

    /// Prepare a public data upload for external signing.
    ///
    /// Encrypts the data into content chunks AND adds the serialized data-map
    /// as its own paid chunk so that `finalize_public_upload` can publish
    /// everything in one shot. The returned `data_map_address` is the
    /// content-addressed address where the data-map chunk will live — anyone
    /// who knows that address can retrieve the original data.
    pub async fn prepare_public_upload(
        &self,
        data: Vec<u8>,
    ) -> Result<PreparePublicUploadResult, ClientError> {
        let mut prepared = self.inner.data_prepare_upload(Bytes::from(data)).await?;

        let data_map_serialized = rmp_serde::to_vec(&prepared.data_map).map_err(|e| {
            ClientError::InternalError { reason: format!("serialize data map: {e}") }
        })?;
        let data_map_address = hex::encode(compute_address(&Bytes::from(data_map_serialized.clone())));

        // Only the WaveBatch payment path is supported — etchit pastes never
        // hit the merkle threshold (64+ chunks). Append the data-map chunk to
        // the wave batch so `finalize_public_upload` can publish it in the
        // same external-signer transaction as the content chunks.
        match &mut prepared.payment_info {
            ExternalPaymentInfo::WaveBatch {
                prepared_chunks,
                payment_intent,
            } => {
                if let Some(data_map_chunk) = self
                    .inner
                    .prepare_chunk_payment(Bytes::from(data_map_serialized))
                    .await?
                {
                    prepared_chunks.push(data_map_chunk);
                    *payment_intent = PaymentIntent::from_prepared_chunks(prepared_chunks);
                }
            }
            ExternalPaymentInfo::Merkle { .. } => {
                return Err(ClientError::InvalidInput {
                    reason: "merkle payment path not supported by prepare_public_upload".into(),
                });
            }
        }

        let intent = wave_batch_payment_intent(&prepared)?;
        let payments = payment_entries(intent);
        let total_amount = intent.total_amount.to_string();

        let upload_id = self.store_pending(prepared).await;

        Ok(PreparePublicUploadResult { upload_id, payments, total_amount, data_map_address })
    }

    /// Finalize a private upload after external payment.
    /// Takes a map of quote_hash (hex) → tx_hash (hex).
    pub async fn finalize_upload(
        &self,
        upload_id: String,
        tx_hashes: HashMap<String, String>,
    ) -> Result<FinalizeUploadResult, ClientError> {
        let prepared = self.take_pending(&upload_id).await?;
        let tx_hash_map = parse_tx_hash_map(&tx_hashes)?;
        let result = self.inner.finalize_upload(prepared, &tx_hash_map).await?;

        Ok(FinalizeUploadResult {
            chunks_stored: result.chunks_stored as u64,
        })
    }

    /// Finalize a public upload after external payment.
    /// Stores all chunks (content + data-map) and returns the public address.
    pub async fn finalize_public_upload(
        &self,
        upload_id: String,
        tx_hashes: HashMap<String, String>,
    ) -> Result<PublicUploadResult, ClientError> {
        let prepared = self.take_pending(&upload_id).await?;

        let data_map_serialized = rmp_serde::to_vec(&prepared.data_map).map_err(|e| {
            ClientError::InternalError { reason: format!("serialize data map: {e}") }
        })?;
        let address = hex::encode(compute_address(&Bytes::from(data_map_serialized)));

        let tx_hash_map = parse_tx_hash_map(&tx_hashes)?;
        let result = self.inner.finalize_upload(prepared, &tx_hash_map).await?;

        Ok(PublicUploadResult {
            address,
            chunks_stored: result.chunks_stored as u64,
        })
    }

    // ===== Wallet Operations =====

    /// Approve token spend for storage payments (one-time).
    pub async fn wallet_approve(&self) -> Result<(), ClientError> {
        self.inner
            .approve_token_spend()
            .await
            .map_err(|e| ClientError::PaymentError {
                reason: e.to_string(),
            })?;
        Ok(())
    }
}

// Non-FFI helpers. Kept in a separate `impl` block so UniFFI does not try to
// expose `PreparedUpload` (which contains non-FFI network types) across the boundary.
impl Client {
    async fn store_pending(&self, prepared: PreparedUpload) -> String {
        let upload_id = hex::encode(rand::random::<[u8; 16]>());
        self.pending_uploads
            .lock()
            .await
            .insert(upload_id.clone(), prepared);
        upload_id
    }

    async fn take_pending(&self, upload_id: &str) -> Result<PreparedUpload, ClientError> {
        self.pending_uploads
            .lock()
            .await
            .remove(upload_id)
            .ok_or_else(|| ClientError::NotFound {
                reason: format!("upload_id {upload_id} not found"),
            })
    }
}

/// Mobile-friendly `ClientConfig`.
///
/// ant-core's defaults target a residential desktop connection with fast
/// upload (`quote_concurrency = 32`, `store_concurrency = 8`). On a mobile
/// device, 32 concurrent DHT lookups plus the close-group peer connect
/// storm overwhelm the UDP socket and the peers: saorsa-transport starts
/// returning `peer did not acknowledge stream data within 5s` on every
/// send, saorsa-core marks the peers disconnected, the routing table
/// empties out, and quote collection fails for the whole upload.
///
/// Lower concurrency lets each request complete before the next one
/// starts, which matches v1's sequential quote flow without going fully
/// serial. Longer timeouts are defensive against slow peers — a 10 s
/// quote timeout isn't much headroom when cellular RTT can spike to 2–3 s.
fn mobile_client_config() -> ClientConfig {
    ClientConfig {
        quote_concurrency: 4,
        store_concurrency: 2,
        quote_timeout_secs: 30,
        store_timeout_secs: 60,
        ..ClientConfig::default()
    }
}

/// Start a P2P node and wait briefly for at least one peer, then return.
///
/// `P2PNode::start()` in saorsa-core 0.21 performs a full DHT bootstrap
/// (connect bootstrap peers → `bootstrap_from_peers` → two rounds of
/// `trigger_self_lookup`) before returning, which can take 30+ seconds on
/// a cold testnet. Rather than blocking the FFI caller for that long, we
/// spawn `start()` as a background task and return as soon as we either
/// have at least one connected peer **or** hit a short deadline. The
/// background task keeps running so the DHT finishes filling after the
/// caller has a usable `Client`.
async fn start_node_with_warmup(node: Arc<P2PNode>) -> Result<(), ClientError> {
    const START_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);
    const WARMUP_POLL: std::time::Duration = std::time::Duration::from_millis(250);

    let start_task = {
        let node = node.clone();
        tokio::spawn(async move { node.start().await })
    };

    let deadline = tokio::time::Instant::now() + START_DEADLINE;
    loop {
        if !node.connected_peers().await.is_empty() {
            log::info!("start_node_with_warmup: have peers, returning early");
            return Ok(());
        }
        if start_task.is_finished() {
            // start() returned before we saw any peers — propagate its result.
            return match start_task.await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(ClientError::InitializationFailed {
                    reason: e.to_string(),
                }),
                Err(e) => Err(ClientError::InitializationFailed {
                    reason: format!("node.start() task panicked: {e}"),
                }),
            };
        }
        if tokio::time::Instant::now() >= deadline {
            log::warn!(
                "start_node_with_warmup: {}s deadline reached, returning with partial bootstrap",
                START_DEADLINE.as_secs()
            );
            return Ok(());
        }
        tokio::time::sleep(WARMUP_POLL).await;
    }
}

/// Parse a hex string into a 32-byte address.
fn hex_to_address(hex: &str) -> Result<[u8; 32], ClientError> {
    let bytes = hex::decode(hex).map_err(|e| ClientError::InvalidInput {
        reason: format!("invalid hex address: {e}"),
    })?;
    bytes
        .try_into()
        .map_err(|_| ClientError::InvalidInput {
            reason: "address must be 32 bytes".into(),
        })
}

/// Extract the `PaymentIntent` from a wave-batch `PreparedUpload`.
/// Returns an error if the upload was prepared with merkle payment.
fn wave_batch_payment_intent(prepared: &PreparedUpload) -> Result<&PaymentIntent, ClientError> {
    match &prepared.payment_info {
        ExternalPaymentInfo::WaveBatch { payment_intent, .. } => Ok(payment_intent),
        ExternalPaymentInfo::Merkle { .. } => Err(ClientError::InvalidInput {
            reason: "merkle payment path not supported over FFI".into(),
        }),
    }
}

/// Build FFI `PaymentEntry` list from an ant-core `PaymentIntent`.
fn payment_entries(intent: &PaymentIntent) -> Vec<PaymentEntry> {
    intent
        .payments
        .iter()
        .map(|(qh, ra, amt)| PaymentEntry {
            quote_hash: format!("{:#x}", qh),
            rewards_address: format!("{:#x}", ra),
            amount: amt.to_string(),
        })
        .collect()
}

/// Parse the FFI `tx_hashes` map (hex strings) into the evmlib types.
fn parse_tx_hash_map(
    tx_hashes: &HashMap<String, String>,
) -> Result<HashMap<evmlib::common::QuoteHash, evmlib::common::TxHash>, ClientError> {
    tx_hashes
        .iter()
        .map(|(qh, th)| {
            let q: [u8; 32] = hex::decode(qh.trim_start_matches("0x"))
                .map_err(|e| ClientError::InvalidInput {
                    reason: format!("invalid quote_hash: {e}"),
                })?
                .try_into()
                .map_err(|_| ClientError::InvalidInput {
                    reason: "quote_hash must be 32 bytes".into(),
                })?;
            let t: [u8; 32] = hex::decode(th.trim_start_matches("0x"))
                .map_err(|e| ClientError::InvalidInput {
                    reason: format!("invalid tx_hash: {e}"),
                })?
                .try_into()
                .map_err(|_| ClientError::InvalidInput {
                    reason: "tx_hash must be 32 bytes".into(),
                })?;
            Ok((q.into(), t.into()))
        })
        .collect()
}
