import {createHighlighter, type BundledLanguage, type Highlighter} from 'shiki';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';

let engine: Promise<Highlighter> | undefined;
const loading = new Map<string, Promise<void>>();

/** One lazy Shiki instance for Activity and Files, compatible with our CSP. */
export async function syntaxHighlighter(language: string) {
  engine ??= createHighlighter({themes: ['github-light', 'github-dark'], langs: [], engine: createJavaScriptRegexEngine()});
  const highlighter = await engine;
  if (!['text', 'plaintext'].includes(language) && !highlighter.getLoadedLanguages().includes(language)) {
    let pending = loading.get(language);
    if (!pending) {
      pending = highlighter.loadLanguage(language as BundledLanguage).catch(() => {});
      loading.set(language, pending);
    }
    await pending;
  }
  return highlighter;
}
