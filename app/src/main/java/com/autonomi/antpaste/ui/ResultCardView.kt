package com.autonomi.antpaste.ui

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.BitmapFactory
import android.provider.MediaStore
import android.view.View
import android.view.animation.OvershootInterpolator
import com.autonomi.antpaste.ContentDetector
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.PasteUtils
import com.autonomi.antpaste.databinding.ActivityMainBinding
import com.autonomi.antpaste.util.shortMessage
import com.google.android.material.snackbar.Snackbar

// Owns the result card: title + address + content (or image), with the
// reveal animation. Used by every flow that lands on the card —
// public/private etch completion, backup result, fetched bytes. Callbacks
// delegate cross-cutting concerns (status line, clipboard, haptics,
// backup-detection) back to the host so this stays pure presentation.
class ResultCardView(
    private val activity: Activity,
    private val binding: ActivityMainBinding,
    private val onShowStatus: (String, Boolean) -> Unit,
    private val onCopy: (String, String) -> Unit,
    private val onHaptic: () -> Unit,
    private val onBackupDetected: (ByteArray) -> Unit,
) {

    // Populate + reveal the card with raw text content. Animated appearance.
    fun show(title: String, address: String, content: String) {
        showText(title, address, content)
    }

    // Branch on content type for fetched bytes: envelope/text/image/backup/binary.
    fun displayFetched(data: ByteArray, address: String) {
        val detected = ContentDetector.detect(data)
        val sizeStr = PasteUtils.formatSize(data.size)

        when (detected.type) {
            ContentDetector.ContentType.ETCH_ENVELOPE -> {
                val raw = data.toString(Charsets.UTF_8)
                val (title, content) = PasteUtils.parseEnvelope(raw)
                showText(title.ifEmpty { "Retrieved" }, address, content)
                onShowStatus("Retrieved • $sizeStr", false)
            }
            ContentDetector.ContentType.IMAGE -> {
                val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size)
                if (bitmap != null) {
                    showText("Image", address, "")
                    binding.resultContent.visibility = View.GONE
                    binding.resultImage.setImageBitmap(bitmap)
                    binding.resultImage.visibility = View.VISIBLE
                    onShowStatus("Retrieved image • $sizeStr", false)
                } else {
                    showBinary(data, detected, address, sizeStr)
                }
            }
            ContentDetector.ContentType.TEXT -> {
                val text = data.toString(Charsets.UTF_8)
                showText("Raw text", address, text)
                onShowStatus("Retrieved text • $sizeStr", false)
            }
            ContentDetector.ContentType.BACKUP -> {
                onBackupDetected(data)
            }
            ContentDetector.ContentType.BINARY -> {
                showBinary(data, detected, address, sizeStr)
            }
        }
    }

    private fun showText(title: String, address: String, content: String) {
        binding.resultTitle.text = title
        binding.resultAddress.text = address
        binding.resultContent.text = content
        binding.resultAddress.setTextColor(0xFF64b5f6.toInt()) // accent_blue
        binding.copyAddressBtn.visibility = View.VISIBLE
        binding.shareButton.visibility = View.VISIBLE
        binding.resultContent.visibility = View.VISIBLE
        // Hint visible only when there's actual text to expand. Binary results
        // pass mime/size strings through here that aren't worth fullscreen-viewing.
        binding.resultExpandHint.visibility = if (content.isNotBlank()) View.VISIBLE else View.GONE
        binding.resultImage.visibility = View.GONE
        binding.resultImage.setImageBitmap(null)
        binding.copyContentBtn.text = "Copy Content"
        binding.copyContentBtn.setOnClickListener {
            onCopy(binding.resultContent.text.toString(), "Content")
        }
        animateAppear()
    }

    // Binary preview: mime + size in the content slot, copy button repurposed
    // as Save-to-Downloads. Data only persists if the user explicitly saves.
    private fun showBinary(
        data: ByteArray,
        detected: ContentDetector.Result,
        address: String,
        sizeStr: String,
    ) {
        showText(
            "${detected.extension.uppercase()} file",
            address,
            "${detected.mimeType}\n$sizeStr",
        )
        binding.resultExpandHint.visibility = View.GONE
        onShowStatus("Retrieved ${detected.extension.uppercase()} • $sizeStr", false)

        binding.copyContentBtn.text = "Save to Downloads"
        binding.copyContentBtn.setOnClickListener {
            val filename = "etchit_${address.take(12)}.${detected.extension}"
            try {
                val resolver = activity.contentResolver
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, filename)
                    put(MediaStore.Downloads.MIME_TYPE, detected.mimeType)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, values
                ) ?: throw RuntimeException("Failed to create file")

                resolver.openOutputStream(uri)?.use { it.write(data) }

                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)

                Snackbar.make(binding.root, "Saved: $filename", Snackbar.LENGTH_LONG)
                    .setBackgroundTint(MainActivity.INK_3)
                    .setTextColor(MainActivity.STATUS_GREEN)
                    .setAction("Open") {
                        val openIntent = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, detected.mimeType)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        activity.startActivity(Intent.createChooser(openIntent, "Open with"))
                    }
                    .setActionTextColor(MainActivity.COPPER)
                    .show()
            } catch (e: Exception) {
                onShowStatus("Failed to save: ${e.shortMessage()}", true)
            }
        }
    }

    private fun animateAppear() {
        val card = binding.resultCard
        card.alpha = 0f
        card.translationY = 60f
        card.scaleX = 0.95f
        card.scaleY = 0.95f
        card.visibility = View.VISIBLE

        val anim = AnimatorSet()
        anim.playTogether(
            ObjectAnimator.ofFloat(card, "alpha", 0f, 1f).setDuration(400),
            ObjectAnimator.ofFloat(card, "translationY", 60f, 0f).setDuration(500),
            ObjectAnimator.ofFloat(card, "scaleX", 0.95f, 1f).setDuration(500),
            ObjectAnimator.ofFloat(card, "scaleY", 0.95f, 1f).setDuration(500),
        )
        anim.interpolator = OvershootInterpolator(0.8f)
        anim.start()

        onHaptic()
    }
}

