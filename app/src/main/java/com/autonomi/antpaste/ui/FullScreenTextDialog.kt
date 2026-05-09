package com.autonomi.antpaste.ui

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.autonomi.antpaste.LineNumberEditText
import com.autonomi.antpaste.MainActivity
import com.autonomi.antpaste.SmartHorizontalScrollView
import com.autonomi.antpaste.SyntaxHighlighter
import com.autonomi.antpaste.SyntaxHighlighters
// Top-level extension fun apply(SyntaxHighlighter, Editable) — needs explicit
// import here since we're outside its source package; not visible by default
// (and shadowed by kotlin.apply otherwise).
import com.autonomi.antpaste.apply

// Plain fullscreen text editor — covers two cases triggered by double-tap.
//   editable=true:  edit the etch content in a focused fullscreen editor.
//                    onCommit fires with the latest text on dismiss
//                    (close button, back, swipe — auto-commit, no Cancel).
//   editable=false: read-only fullscreen view of fetched text that was
//                    truncated to maxLines in the result card.
// Top bar: ✕ close, optional title, char count, syntax picker, Save.
// onSave receives (suggestedFilename, currentText) so the caller can wire
// it into a SAF CreateDocument launcher; this keeps the dialog free of
// activity-result plumbing.
fun showFullScreenTextDialog(
    activity: Activity,
    title: String,
    initialText: String,
    editable: Boolean,
    onCommit: ((String) -> Unit)? = null,
    onSave: ((suggestedName: String, content: String) -> Unit)? = null,
) {
    val dp = activity.resources.displayMetrics.density
    val pad12 = (12 * dp).toInt()
    val pad16 = (16 * dp).toInt()

    val dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)

    val root = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(MainActivity.INK)
        fitsSystemWindows = true
    }

    val toolbar = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        setBackgroundColor(MainActivity.INK_2)
        elevation = 4 * dp
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            (56 * dp).toInt(),
        )
    }
    val closeBtn = android.widget.ImageButton(activity).apply {
        setImageResource(android.R.drawable.ic_menu_revert)
        setColorFilter(MainActivity.BONE)
        background = null
        setPadding(pad12, pad12, pad12, pad12)
        contentDescription = "Close"
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.MATCH_PARENT,
        )
    }
    toolbar.addView(closeBtn)
    if (title.isNotBlank()) {
        toolbar.addView(TextView(activity).apply {
            text = title
            setTextColor(MainActivity.BONE)
            textSize = 15f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(pad12, 0, pad12, 0)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
    } else {
        toolbar.addView(View(activity).apply {
            layoutParams = LinearLayout.LayoutParams(0, 1, 1f)
        })
    }
    val charCount = TextView(activity).apply {
        setTextColor(MainActivity.ASH)
        textSize = 12f
        typeface = android.graphics.Typeface.MONOSPACE
        setPadding(0, 0, pad12, 0)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
    }
    toolbar.addView(charCount)
    var currentHighlighter: SyntaxHighlighter = SyntaxHighlighters.detectLanguage(initialText)
    val langBtn = TextView(activity).apply {
        text = "{}"
        setTextColor(if (currentHighlighter is SyntaxHighlighters.PlainHighlighter) MainActivity.ASH else MainActivity.COPPER_BRIGHT)
        textSize = 14f
        typeface = android.graphics.Typeface.MONOSPACE
        setPadding(pad12, pad12, pad12, pad12)
        isClickable = true
        isFocusable = true
        contentDescription = "Syntax highlighting"
    }
    toolbar.addView(langBtn)
    val saveBtn = TextView(activity).apply {
        text = "Save"
        setTextColor(MainActivity.COPPER_BRIGHT)
        textSize = 14f
        setTypeface(typeface, android.graphics.Typeface.BOLD)
        letterSpacing = 0.04f
        setPadding(pad16, pad12, pad16, pad12)
        isClickable = true
        isFocusable = true
        contentDescription = "Save as file"
    }
    toolbar.addView(saveBtn)
    root.addView(toolbar)

    // 1dp copper-dim hairline under the toolbar.
    root.addView(View(activity).apply {
        setBackgroundColor(0xFF8a4e1d.toInt())
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            Math.max(1, (1 * dp).toInt()),
        )
    })

    val editText = LineNumberEditText(activity).apply {
        setText(initialText)
        setTextColor(MainActivity.BONE)
        setHintTextColor(MainActivity.ASH)
        textSize = 15f
        typeface = android.graphics.Typeface.MONOSPACE
        setLineSpacing(0f, 1.6f)
        setPadding(
            gutterWidthPx + (12 * dp).toInt(),
            (28 * dp).toInt(),
            (24 * dp).toInt(),
            (24 * dp).toInt(),
        )
        gravity = android.view.Gravity.TOP or android.view.Gravity.START
        setBackgroundColor(0)
        isVerticalScrollBarEnabled = true
        scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
        overScrollMode = View.OVER_SCROLL_NEVER
        setHorizontallyScrolling(true)
        if (editable) {
            isFocusable = true
            isFocusableInTouchMode = true
            isCursorVisible = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or
                android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            // Open at start so the reading model is top-to-bottom even after a
            // big paste — the previous setSelection(end) jumped to the bottom.
            setSelection(0)
        } else {
            isFocusable = false
            isCursorVisible = false
            inputType = android.text.InputType.TYPE_NULL
            setTextIsSelectable(true)
        }
    }
    // SmartHorizontalScrollView only intercepts when the gesture is clearly
    // horizontal — vertical drags pass through at native EditText speed.
    val editorScroll = SmartHorizontalScrollView(activity).apply {
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f,
        )
        isHorizontalScrollBarEnabled = true
        isFillViewport = true
        overScrollMode = View.OVER_SCROLL_NEVER
        scrollBarStyle = View.SCROLLBARS_INSIDE_OVERLAY
        isSmoothScrollingEnabled = true
    }
    editText.layoutParams = android.widget.FrameLayout.LayoutParams(
        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
    )
    editorScroll.addView(editText)
    root.addView(editorScroll)

    // Pinch-to-zoom: 10sp .. 28sp. Gutter line numbers track via getLineBaseline().
    var currentTextSp = 15f
    val minSp = 10f
    val maxSp = 28f
    val scaleDetector = android.view.ScaleGestureDetector(
        activity,
        object : android.view.ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: android.view.ScaleGestureDetector): Boolean {
                val next = (currentTextSp * detector.scaleFactor).coerceIn(minSp, maxSp)
                if (next != currentTextSp) {
                    currentTextSp = next
                    editText.textSize = currentTextSp
                }
                return true
            }
        },
    )
    editText.setOnTouchListener { _, event ->
        scaleDetector.onTouchEvent(event)
        false
    }

    fun updateCharCount() {
        val n = editText.text.length
        charCount.text = String.format(java.util.Locale.US, "%,d", n)
    }
    updateCharCount()
    // Highlight model: tokenize + apply spans once per text-change (debounced)
    // or language-change. Scroll path does nothing — EditText paints natively.
    // Very large docs (~28K+ chars) can exceed Android's SpannableStringBuilder
    // perf wall around 5-7K spans; the tail goes uncoloured but scroll stays smooth.
    fun rehighlight() {
        val text = editText.text ?: return
        if (currentHighlighter is SyntaxHighlighters.PlainHighlighter) {
            SyntaxHighlighters.clear(text)
            return
        }
        currentHighlighter.apply(text)
    }
    val rehighlightHandler = android.os.Handler(android.os.Looper.getMainLooper())
    var rehighlightToken: Runnable? = null
    fun scheduleRehighlight(delayMs: Long = 180L) {
        rehighlightToken?.let { rehighlightHandler.removeCallbacks(it) }
        val r = Runnable { rehighlight() }
        rehighlightToken = r
        rehighlightHandler.postDelayed(r, delayMs)
    }
    editText.addTextChangedListener(object : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) {
            updateCharCount()
            scheduleRehighlight()
        }
    })
    // TextWatcher only fires on change; the editor opens with text already set,
    // so paint the auto-detected highlighter once after layout settles.
    editText.post { rehighlight() }

    langBtn.setOnClickListener {
        val items = SyntaxHighlighters.all.map { it.displayName }.toTypedArray()
        val currentIdx = SyntaxHighlighters.all.indexOf(currentHighlighter).coerceAtLeast(0)
        AlertDialog.Builder(activity)
            .setTitle("Syntax highlighting")
            .setSingleChoiceItems(items, currentIdx) { d, which ->
                currentHighlighter = SyntaxHighlighters.all[which]
                langBtn.setTextColor(if (currentHighlighter is SyntaxHighlighters.PlainHighlighter) MainActivity.ASH else MainActivity.COPPER_BRIGHT)
                rehighlight()
                d.dismiss()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    dialog.setContentView(root)
    dialog.window?.apply {
        setLayout(
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        )
        setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        setBackgroundDrawable(android.graphics.drawable.ColorDrawable(MainActivity.INK_2))
    }

    // Auto-commit on every dismiss flavour (close button, back, swipe).
    dialog.setOnDismissListener {
        if (editable) onCommit?.invoke(editText.text.toString())
    }
    closeBtn.setOnClickListener { dialog.dismiss() }
    saveBtn.setOnClickListener {
        val baseName = title.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "etchit" }
        onSave?.invoke("$baseName.txt", editText.text.toString())
        dialog.dismiss()
    }

    dialog.show()
    if (editable) {
        editText.requestFocus()
        val imm = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE)
            as android.view.inputmethod.InputMethodManager
        imm.showSoftInput(editText, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
    }
    // requestFocus + IME show both auto-scroll-to-cursor; force back to top
    // *after* the IME animation settles so the editor opens reading-top-down.
    editText.postDelayed({
        editText.setSelection(0)
        editText.scrollTo(0, 0)
        editorScroll.scrollTo(0, 0)
    }, 250L)
}
