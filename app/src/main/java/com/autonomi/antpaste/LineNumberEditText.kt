package com.autonomi.antpaste

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.widget.EditText

/**
 * EditText with a fine line-number gutter on the left.
 *
 * Numbers are *source* lines (one per `\n`), not visual lines, so soft-wrapped
 * continuations don't get a stray number. Painted right-aligned in the gutter,
 * 10sp mono in dim ash. The host is responsible for setting `paddingLeft` to
 * `gutterWidthPx + a small margin` so the text body clears the gutter.
 */
class LineNumberEditText @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : EditText(context, attrs) {

    val gutterWidthPx: Int = (40 * context.resources.displayMetrics.density).toInt()

    private val gutterPaint = Paint().apply {
        isAntiAlias = true
        color = GUTTER_COLOR
        textSize = 10f * context.resources.displayMetrics.scaledDensity
        typeface = Typeface.MONOSPACE
        textAlign = Paint.Align.RIGHT
    }

    private val gutterRightX: Float =
        gutterWidthPx - 8 * context.resources.displayMetrics.density

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val l = layout ?: return
        val txt = text ?: return

        // The Layout coordinates are relative to the start of the text, but
        // EditText draws the text starting at totalPaddingTop within the View.
        // Add it so our gutter numbers land on the same baselines.
        val padTop = totalPaddingTop.toFloat()

        // Line 1 is always at visual line 0.
        var srcNum = 1
        canvas.drawText(
            srcNum.toString(),
            gutterRightX,
            padTop + l.getLineBaseline(0).toFloat(),
            gutterPaint,
        )
        var lastVisualDrawn = 0

        // Each newline starts a new source line at the *next* offset.
        var i = 0
        val n = txt.length
        while (i < n) {
            if (txt[i] == '\n') {
                val nextOffset = i + 1
                if (nextOffset <= n) {
                    val visualLine = l.getLineForOffset(nextOffset)
                    if (visualLine != lastVisualDrawn) {
                        srcNum++
                        canvas.drawText(
                            srcNum.toString(),
                            gutterRightX,
                            padTop + l.getLineBaseline(visualLine).toFloat(),
                            gutterPaint,
                        )
                        lastVisualDrawn = visualLine
                    }
                }
            }
            i++
        }
    }

    private companion object {
        private const val GUTTER_COLOR = 0xFF6a6a6a.toInt() // between ASH and ASH_DIM
    }
}
