package com.autonomi.antpaste

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks in the upload-neutrality principle: bytes that go to the network
 * carry zero etch/it identification. The expensive part of getting this
 * right isn't writing it — it's never accidentally re-introducing a name
 * drop. These assertions catch a regression at PR time.
 */
class BlogHtmlTest {

    @Test
    fun output_contains_no_literal_brand_strings() {
        val html = BlogHtml.render("A Title", "A body.")
        for (forbidden in listOf("etchit", "etch/it", "etch>it", "etchit.io")) {
            assertFalse(
                "blog HTML must not contain the literal string `$forbidden`",
                html.contains(forbidden, ignoreCase = true),
            )
        }
    }

    @Test
    fun output_contains_no_generator_meta() {
        val html = BlogHtml.render("Title", "Body.")
        assertFalse(
            "blog HTML must not carry a `<meta name=\"generator\">` stamp",
            html.contains("name=\"generator\"", ignoreCase = true),
        )
    }

    @Test
    fun escapes_title_and_body() {
        val html = BlogHtml.render("<script>x</script>", "&\"<>")
        assertTrue(html.contains("&lt;script&gt;"))
        assertTrue(html.contains("&amp;"))
        assertFalse(html.contains("<script>x</script>"))
    }

    @Test
    fun splits_paragraphs_on_blank_lines() {
        val html = BlogHtml.render("T", "one\n\ntwo\n\nthree")
        assertEquals(3, html.split("<p>").size - 1)
    }

    @Test
    fun empty_body_renders_an_explicit_placeholder() {
        val html = BlogHtml.render("T", "   ")
        assertTrue(html.contains("(this post has no body)"))
    }
}
