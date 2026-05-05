package com.autonomi.antpaste

import android.content.Context
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.HorizontalScrollView
import kotlin.math.abs

/**
 * HorizontalScrollView that only claims a touch when the gesture is clearly
 * more horizontal than vertical. Default HSV starts intercepting as soon as
 * any movement crosses touch-slop, which adds latency to every up/down drag
 * inside its child — felt as laggy vertical scroll in the fullscreen editor.
 *
 * This subclass lets all DOWN events pass through, then intercepts only when
 * the cumulative horizontal delta beats the vertical delta by a clear margin.
 */
class SmartHorizontalScrollView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : HorizontalScrollView(context, attrs) {

    private val touchSlop: Int = ViewConfiguration.get(context).scaledTouchSlop
    private var downX: Float = 0f
    private var downY: Float = 0f

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        // Multi-touch (e.g. pinch-to-zoom) must reach the child untouched.
        if (ev.pointerCount > 1) return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                // Don't claim yet — let the child see the DOWN.
                super.onInterceptTouchEvent(ev) // keeps internal scroller state happy
                return false
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = abs(ev.x - downX)
                val dy = abs(ev.y - downY)
                // Past slop AND horizontal dominates vertical by 1.5×.
                if (dx > touchSlop && dx > dy * 1.5f) return true
                return false
            }
        }
        return super.onInterceptTouchEvent(ev)
    }
}
