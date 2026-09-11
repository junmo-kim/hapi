package app.hapi.companion.feature.chat.blocks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import app.hapi.companion.R
import app.hapi.companion.ui.markdown.CodeBlock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Bounded rendering for inputs and outputs, with the complete payload accessible. */
@Composable
internal fun ToolTextContent(code: String, language: String? = null, terminal: Boolean = false, isError: Boolean = false) {
    if (code.length <= TOOL_TEXT_PAGE_SIZE) {
        if (terminal) TerminalText(code, isError = isError) else CodeBlock(code = code, language = language)
        return
    }
    val pages by produceState<List<String>>(emptyList(), code) {
        value = emptyList()
        value = withContext(Dispatchers.Default) { toolTextPages(code) }
    }
    var visiblePages by remember(code) { mutableIntStateOf(1) }
    @Suppress("DEPRECATION")
    val clipboard = LocalClipboardManager.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = { clipboard.setText(AnnotatedString(code)) }) {
            Text(stringResource(R.string.chat_copy_full_content))
        }
        if (pages.isEmpty()) CircularProgressIndicator()
        pages.take(visiblePages).forEach { page ->
            if (terminal) TerminalText(page, isError = isError) else CodeBlock(code = page, language = language)
        }
        if (visiblePages < pages.size) {
            Text(stringResource(R.string.chat_showing_parts, visiblePages, pages.size))
            TextButton(onClick = { visiblePages++ }) { Text(stringResource(R.string.chat_load_more_content)) }
        }
    }
}
