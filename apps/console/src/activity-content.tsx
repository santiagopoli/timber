import {isValidElement, useState, type ReactNode} from 'react';
import {BookOpenIcon, CameraIcon, CodeIcon, ContainerIcon, FileCodeIcon, FolderSearchIcon, GitBranchIcon, GlobeIcon, KeyboardIcon, MousePointer2Icon, PackageIcon, SaveIcon, SearchIcon, TerminalIcon, WrenchIcon, WrapTextIcon} from 'lucide-react';
import {defaultUrlTransform} from 'streamdown';
import type {BundledLanguage} from 'shiki';
import {CodeBlock, CodeBlockCopyButton, CodeBlockHeader} from '@/components/ai-elements/code-block';
import {MessageResponse} from '@/components/ai-elements/message';
import {Button} from '@/components/ui/button';

type Format = {code: string; language: string};
const extensions: Record<string,string> = {py:'python',js:'javascript',mjs:'javascript',cjs:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',json:'json',jsonc:'jsonc',md:'markdown',mdx:'mdx',css:'css',html:'html',xml:'xml',svg:'xml',yml:'yaml',yaml:'yaml',toml:'toml',sh:'bash',bash:'bash',zsh:'bash',sql:'sql',go:'go',rs:'rust',java:'java',c:'c',h:'c',cpp:'cpp',rb:'ruby',php:'php',swift:'swift',kt:'kotlin',vue:'vue',svelte:'svelte',diff:'diff',patch:'diff'};
const languages: Record<string,string> = {sh:'bash',shell:'bash',js:'javascript',ts:'typescript',py:'python',md:'markdown',txt:'text',plaintext:'text'};
const languageName = (language: string) => languages[language.toLowerCase()] || language.toLowerCase();
const markdownBody = (value: string) => value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

export function outputFormat(output: string, name: string, input: Record<string,unknown>): Format {
  const path = typeof input.path === 'string' ? input.path : '';
  if (['readFile','read_file'].includes(name) && path) {
    const file = path.split('/').pop()!.toLowerCase();
    return {code: output, language: file === 'dockerfile' ? 'dockerfile' : file === 'makefile' ? 'makefile' : extensions[file.split('.').pop()!] || 'text'};
  }
  if (name === 'load_skill') return {code: markdownBody(output), language: 'markdown'};
  if (/^(?:diff --git |@@ -\d|--- a\/)/m.test(output)) return {code: output, language: 'diff'};
  if (output.length <= 65_536 && /^[\s]*[\[{]/.test(output)) {
    try {
      const parsed: unknown = JSON.parse(output);
      const compact = output.replace(/"(?:\\.|[^"\\])*"|\s+/g, part=>part.startsWith('"') ? part : '');
      // Only reindent if parsing preserved every literal, key and numeric value.
      return {code: JSON.stringify(parsed) === compact ? JSON.stringify(parsed, null, 2) : output, language: 'json'};
    } catch { /* Partial JSON is still useful as plain output. */ }
  }
  return {code: output, language: 'text'};
}

/** Identify the leading executable only; quoted arguments are never commands. */
function executable(command: string) {
  const words = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]!) || ['env','sudo','command'].includes(words[0]!) || /^-(?:v|V|p|u|n)$/.test(words[0]!))) words.shift();
  return (words[0] || '').split('/').pop() || '';
}

export function activityIdentity(name: string, command = '') {
  if (name === 'exec') {
    const program = executable(command);
    if (['git','gh'].includes(program)) return {Icon: GitBranchIcon, label: 'Git'};
    if (/^(?:npm|npx|pnpm|yarn|bun|pip\d*|uv|poetry|cargo|apt|apt-get|brew)$/.test(program)) return {Icon: PackageIcon, label: 'Packages'};
    if (/^(?:python[\d.]*|node|deno|ruby|go|java|php)$/.test(program)) return {Icon: CodeIcon, label: program.startsWith('python') ? 'Python' : program === 'node' ? 'Node.js' : program};
    if (['docker','podman'].includes(program)) return {Icon: ContainerIcon, label: 'Container'};
    if (['curl','wget','ssh'].includes(program)) return {Icon: GlobeIcon, label: 'Network'};
    if (['rg','grep','find','fd'].includes(program)) return {Icon: SearchIcon, label: 'Search'};
    if (['ls','pwd','cd','tree'].includes(program)) return {Icon: FolderSearchIcon, label: 'Files'};
    if (['cat','head','tail','sed','awk'].includes(program)) return {Icon: FileCodeIcon, label: 'File contents'};
    return {Icon: TerminalIcon, label: 'Terminal'};
  }
  if (name.startsWith('github_') || ['gitClone','gitPush'].includes(name)) return {Icon: GitBranchIcon, label: 'GitHub'};
  if (['readFile','read_file','writeFile','write_file'].includes(name)) return {Icon: FileCodeIcon, label: 'File'};
  if (['listFiles','list_files'].includes(name)) return {Icon: FolderSearchIcon, label: 'Files'};
  if (name === 'load_skill') return {Icon: BookOpenIcon, label: 'Skill'};
  if (['screenshot','desktop_screenshot'].includes(name)) return {Icon: CameraIcon, label: 'Screenshot'};
  if (/click|move|drag/i.test(name) && name !== 'remove_app') return {Icon: MousePointer2Icon, label: 'Mouse'};
  if (['type','key','desktop_type','desktop_key'].includes(name)) return {Icon: KeyboardIcon, label: 'Keyboard'};
  if (['navigate','browser_navigate','publish_app','list_apps','remove_app'].includes(name)) return {Icon: GlobeIcon, label: 'App'};
  if (name === 'checkpoint') return {Icon: SaveIcon, label: 'Checkpoint'};
  return {Icon: WrenchIcon, label: 'Tool'};
}

export function ActivityCode({code, language='text', compact=false, copyText=code}: {code:string;language?:string;compact?:boolean;copyText?:string}) {
  const [wrap, setWrap] = useState(false), [copyError, setCopyError] = useState('');
  const limit = compact ? 2_000 : 65_536, visible = code.length > limit ? code.slice(0,limit) : code;
  // The full source remains available to Copy even when rendering is bounded.
  return <div className={`timber-code${compact ? ' is-compact' : ''}${wrap ? ' is-wrapped' : ''}`}>
    <CodeBlock code={visible} copyText={copyText} language={languageName(language) as BundledLanguage} style={{contentVisibility:'visible',containIntrinsicSize:'none'}}>
      {!compact && <CodeBlockHeader><span>{language === 'text' ? 'Text' : languageName(language)}</span><div className="timber-code-actions">
        {copyError && <span role="status">{copyError}</span>}
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Wrap lines" aria-pressed={wrap} title="Wrap lines" onClick={()=>setWrap(!wrap)}><WrapTextIcon/></Button>
        <CodeBlockCopyButton type="button" size="icon-sm" aria-label="Copy code" title="Copy code" onCopy={()=>setCopyError('')} onError={()=>setCopyError('Copy failed')}/>
      </div></CodeBlockHeader>}
    </CodeBlock>
    {visible.length < code.length && !compact && <p className="timber-code-limit">Preview limited to 64 KiB. Copy includes the full output.</p>}
  </div>;
}

function MarkdownCode({children,compact}: {children?:ReactNode;compact?:boolean}) {
  if (isValidElement<{children?:ReactNode;className?:string}>(children) && typeof children.props.children === 'string') {
    return <ActivityCode compact={compact} code={children.props.children.replace(/\n$/, '')} language={/language-(\S+)/.exec(children.props.className || '')?.[1] || 'text'}/>;
  }
  return <pre>{children}</pre>;
}

export function ActivityOutput({format, compact=false, source=format.code}: {format:Format;compact?:boolean;source?:string}) {
  // The collapsed output shows only three lines. Do not retain hundreds of
  // hidden token/line elements per action just because the source is short.
  // Command previews use ActivityCode directly and keep horizontal scrolling.
  const visible = compact ? format.code.slice(0,format.language === 'markdown' ? 600 : 2_000).split('\n',3).join('\n') : format.code;
  if (format.language === 'markdown') return <div className={`timber-tool-markdown${compact ? ' is-compact' : ''}`}>
    <MessageResponse className="timber-markdown" mode="static" skipHtml plugins={{}} components={{img:()=>null,a:compact ? ({children})=><span>{children}</span> : undefined,pre:({children})=><MarkdownCode compact={compact} children={children}/>}} controls={false} linkSafety={{enabled:false}} urlTransform={defaultUrlTransform}>{visible.slice(0,65_536)}</MessageResponse>
  </div>;
  return <ActivityCode code={visible} copyText={source} language={format.language} compact={compact}/>;
}
