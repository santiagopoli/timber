/** Only an explicitly selected recipient can be sent; this checks its visible token still exists. */
export function hasBotMention(text: string, name: string) {
  const token = `@${name}`;
  let start = text.indexOf(token);
  while (start !== -1) {
    const end = start + token.length;
    if ((start === 0 || /\s/.test(text[start - 1])) && (end === text.length || /[\s,.;:!?()[\]{}"']/.test(text[end]))) return true;
    start = text.indexOf(token, start + token.length);
  }
  return false;
}
