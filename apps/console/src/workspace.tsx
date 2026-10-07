import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { ChevronRightIcon, DownloadIcon, FileIcon, FolderIcon, GitBranchIcon, RefreshCwIcon, XIcon } from 'lucide-react';
import './workspace.css';

type Entry = {name:string;path:string;kind:'file'|'directory'|'symlink';size:number;accessible:boolean};
type Tree = {path:string;entries:Entry[];truncated:boolean};
type FileView = {path:string;name:string;size:number;mimeType:string;kind:'text'|'image'|'binary';content?:string;language?:string;truncated:boolean;downloadable:boolean};
type Project = {path:string;name:string;branch:string|null;head:string|null;detached:boolean;dirty:boolean;staged:number;unstaged:number;untracked:number;error?:string};
type Change = {path:string;previousPath?:string;indexStatus:string;worktreeStatus:string;staged:boolean;unstaged:boolean;untracked:boolean};
type Diff = {project:string;path:string;mode:string;diff:string;truncated:boolean;binary:boolean};
export type WorkspaceCallbacks = {
  request(botId:string,path:string):Promise<unknown>;
  download(botId:string,path:string):Promise<Response>;
};
const query = (route:string,values:Record<string,string>) => `/workspace/${route}?${new URLSearchParams(values)}`;
const size = (bytes:number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes/1024).toFixed(1)} KiB` : `${(bytes/1024**2).toFixed(1)} MiB`;
const parent = (path:string) => path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '.';
const join = (root:string,path:string) => root === '.' ? path : `${root}/${path}`;
const safeImages = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','image/x-icon']);

let highlighter:Promise<Highlighter>|null=null;
function SourceCode({code,language='text'}:{code:string;language?:string}) {
  const [highlight,setHighlight]=useState<{code:string;language:string;tokens:ThemedToken[][]}|null>(null);
  useEffect(()=>{
    let active=true;
    highlighter ??= createHighlighter({themes:['github-dark'],langs:[],engine:createJavaScriptRegexEngine()});
    void highlighter.then(async engine=>{
      let selected=language;
      if(!['text','plaintext'].includes(selected) && !engine.getLoadedLanguages().includes(selected)) {
        try {await engine.loadLanguage(selected as BundledLanguage);} catch {selected='text';}
      }
      const tokens=engine.codeToTokens(code,{lang:selected as BundledLanguage,theme:'github-dark'}).tokens;
      if(active)setHighlight({code,language,tokens});
    }).catch(()=>{ /* Unknown syntaxes retain their exact escaped source. */ });
    return()=>{active=false;};
  },[code,language]);
  const tokens=highlight?.code===code && highlight.language===language?highlight.tokens:null;
  return <pre className="workspace-source"><code>{(tokens || code.split('\n').map(line=>[{content:line}])).map((line,index)=><span className="workspace-source-line" key={index}><span className="workspace-line-number" aria-hidden="true">{index+1}</span><span>{line.length?line.map((token,n)=><span key={n} style={'color' in token && typeof token.color==='string'?{color:token.color}:undefined}>{token.content}</span>):'\n'}</span></span>)}</code></pre>;
}

function Workspace({ botId, callbacks }: {botId:string;callbacks:WorkspaceCallbacks}) {
  const [tree,setTree] = useState<Tree | null>(null), [projects,setProjects] = useState<Project[]>([]);
  const [project,setProject] = useState<Project | null>(null), [changes,setChanges] = useState<Change[]>([]);
  const [file,setFile] = useState<FileView | null>(null), [diff,setDiff] = useState<Diff | null>(null);
  const [image,setImage] = useState<string | null>(null), [error,setError] = useState('');
  const [busy,setBusy] = useState(false), [reading,setReading] = useState(false), [mode,setMode] = useState<'files'|'changes'>('files');
  const [limited,setLimited] = useState(false), [tab,setTab] = useState<'file'|'unstaged'|'staged'>('file');
  const alive = useRef(true), navigation = useRef(0), selection = useRef(0), objectURL = useRef<string | null>(null), projectGeneration = useRef(0), scanGeneration = useRef(0);
  const releaseImage = () => {if (objectURL.current) URL.revokeObjectURL(objectURL.current); objectURL.current=null; setImage(null);};
  const report = (err:unknown) => {if (alive.current) setError(err instanceof Error ? err.message : 'Workspace could not be loaded. Try refreshing.');};
  const request = <T,>(route:string) => callbacks.request(botId,route) as Promise<T>;
  const loadTree = async (path='.') => {
    const generation=++navigation.current; setBusy(true);setError('');
    try {const data=await request<Tree>(query('tree',{path})); if(alive.current && generation===navigation.current)setTree(data);}
    catch(err){if(generation===navigation.current)report(err);}
    finally{if(alive.current && generation===navigation.current)setBusy(false);}
  };
  const loadProjects = async () => {
    const generation=++scanGeneration.current;
    try {const data=await request<{projects:Project[];truncated:boolean}>('/workspace/projects');if(alive.current && generation===scanGeneration.current){setProjects(data.projects);setLimited(data.truncated);}}
    catch(err){if(generation===scanGeneration.current)report(err);}
  };
  const chooseProject = async (value:Project) => {
    setProject(value);setMode('changes');setChanges([]);setError('');
    const generation=++projectGeneration.current;
    try {const data=await request<{changes:Change[];truncated:boolean}>(query('changes',{project:value.path}));if(alive.current && generation===projectGeneration.current){setChanges(data.changes);setLimited(data.truncated);}}
    catch(err){if(generation===projectGeneration.current)report(err);}
  };
  const openFile = async (path:string,view:'file'|'unstaged'|'staged'='file',source=project) => {
    const generation=++selection.current; releaseImage();setFile(null);setDiff(null);setTab(view);setReading(true);setError('');
    try {
      if(view!=='file' && source){
        const data=await request<Diff>(query('diff',{project:source.path,path,mode:view}));
        if(alive.current && generation===selection.current)setDiff(data);
      } else {
        const data=await request<FileView>(query('file',{path}));
        if(!alive.current || generation!==selection.current)return;
        setFile(data);
        if(data.kind==='image' && safeImages.has(data.mimeType) && data.downloadable){
          const response=await callbacks.download(botId,query('download',{path}));
          if(!response.ok)throw new Error('Image could not be loaded.');
          const blob=await response.blob();
          if(!alive.current || generation!==selection.current)return;
          const url=URL.createObjectURL(new Blob([blob],{type:data.mimeType}));objectURL.current=url;setImage(url);
        }
      }
    } catch(err){if(generation===selection.current)report(err);}
    finally{if(alive.current && generation===selection.current)setReading(false);}
  };
  const download = async () => {
    if(!file)return;
    try {const response=await callbacks.download(botId,query('download',{path:file.path}));if(!response.ok)throw new Error('File could not be downloaded.');const blob=await response.blob();if(!alive.current)return;const url=URL.createObjectURL(new Blob([blob],{type:'application/octet-stream'}));const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    catch(err){report(err);}
  };
  useEffect(()=>{alive.current=true;void loadTree();void loadProjects();return()=>{alive.current=false;navigation.current++;selection.current++;projectGeneration.current++;scanGeneration.current++;if(objectURL.current)URL.revokeObjectURL(objectURL.current);};},[botId]);
  const selectedPath = diff ? join(diff.project,diff.path) : file?.path;
  const selectedChange = project && selectedPath ? changes.find(c=>join(project.path,c.path)===selectedPath) : undefined;
  const breadcrumbs = tree?.path === '.' ? [] : tree?.path.split('/') ?? [];
  return <div className="timber-workspace" data-workspace-explorer>
    <header className="workspace-heading"><div><h2>Workspace</h2><p>Files, code and Git projects in this bot’s computer.</p></div><button type="button" className="secondary" aria-label="Refresh workspace" onClick={()=>{void loadTree(tree?.path);void loadProjects();if(project)void chooseProject(project);}} disabled={busy}><RefreshCwIcon/> Refresh</button></header>
    {error && <div className="workspace-error" role="alert">{error}</div>}
    <div className="workspace-projects" aria-label="Git projects">{projects.map(p=><button type="button" key={p.path} className={`workspace-project ${project?.path===p.path?'selected':''}`} onClick={()=>void chooseProject(p)}><span className="workspace-project-name"><GitBranchIcon/>{p.name}</span><span className="workspace-project-path">{p.path}</span><span>{p.error || (p.detached ? `Detached · ${p.head?.slice(0,7) || 'unknown'}` : p.branch || 'New repository')}</span>{!p.error && <small>{p.dirty ? `${p.staged} staged · ${p.unstaged} modified · ${p.untracked} untracked` : 'Clean working tree'}</small>}</button>)}{!projects.length && <span className="workspace-muted">Git projects appear here when repositories are present.</span>}</div>
    {limited && <p className="workspace-notice">The workspace scan reached its limit. Open a project folder to inspect files directly.</p>}
    <div className="workspace-layout"><aside className="workspace-sidebar"><div className="workspace-modes"><button type="button" aria-pressed={mode==='files'} onClick={()=>setMode('files')}>Files</button><button type="button" aria-pressed={mode==='changes'} disabled={!project} onClick={()=>setMode('changes')}>Changes {project ? `(${changes.length})` : ''}</button></div>
      {mode==='files' ? <><nav className="workspace-breadcrumbs" aria-label="Workspace folders"><button type="button" onClick={()=>void loadTree('.')}>workspace</button>{breadcrumbs.map((part,index)=><span key={index}><ChevronRightIcon/><button type="button" onClick={()=>void loadTree(breadcrumbs.slice(0,index+1).join('/'))}>{part}</button></span>)}</nav><div className="workspace-file-list" aria-busy={busy}>{tree?.path!=='.' && tree && <button type="button" className="workspace-entry" onClick={()=>void loadTree(parent(tree.path))}><FolderIcon/>..</button>}{tree?.entries.map(entry=><button type="button" className={`workspace-entry ${selectedPath===entry.path?'selected':''}`} key={entry.path} title={entry.accessible ? entry.path : 'Symbolic links and special files cannot be opened'} disabled={!entry.accessible} onClick={()=>entry.kind==='directory'?void loadTree(entry.path):void openFile(entry.path)}>{entry.kind==='directory'?<FolderIcon/>:<FileIcon/>}<span>{entry.name}{entry.kind==='symlink'?' ↗':''}</span>{entry.kind==='file' && <small>{size(entry.size)}</small>}</button>)}{tree && !tree.entries.length && <p className="workspace-muted">This folder is empty.</p>}{tree?.truncated && <p className="workspace-notice">Showing the first 2,000 entries.</p>}</div></> : <div className="workspace-changes"><p className="workspace-project-label">{project?.path}</p>{changes.map(change=><button type="button" className={`workspace-entry ${selectedPath===join(project!.path,change.path)?'selected':''}`} key={change.path} title={change.previousPath?`${change.previousPath} → ${change.path}`:change.path} onClick={()=>void openFile(change.path,change.unstaged||change.untracked?'unstaged':'staged')}><span className="workspace-git-status">{change.untracked?'U':`${change.indexStatus}${change.worktreeStatus}`.trim()}</span><span>{change.path}</span></button>)}{!changes.length && <p className="workspace-muted">No changes in this project.</p>}</div>}
    </aside><section className="workspace-viewer" aria-label="File preview" aria-busy={reading}>{selectedPath && <div className="workspace-file-toolbar"><strong title={selectedPath}>{selectedPath}</strong>{file && <span>{size(file.size)}</span>}{file?.downloadable && <button type="button" aria-label="Download file" onClick={()=>void download()}><DownloadIcon/></button>}<button type="button" aria-label="Close file" onClick={()=>{selection.current++;releaseImage();setFile(null);setDiff(null);setReading(false);}}><XIcon/></button></div>}
      {selectedChange && <div className="workspace-file-tabs"><button type="button" aria-pressed={tab==='file'} onClick={()=>void openFile(selectedPath!)}>File</button><button type="button" disabled={!selectedChange.unstaged && !selectedChange.untracked} aria-pressed={tab==='unstaged'} onClick={()=>void openFile(selectedChange.path,'unstaged')}>Working changes</button><button type="button" disabled={!selectedChange.staged} aria-pressed={tab==='staged'} onClick={()=>void openFile(selectedChange.path,'staged')}>Staged changes</button></div>}
      {reading && <div className="workspace-empty" role="status">Loading preview…</div>}
      {!reading && !file && !diff && <div className="workspace-empty"><FileIcon/><h3>Select a file</h3><p>Browse source with syntax highlighting, preview images, or inspect Git changes.</p></div>}
      {file?.truncated && file.kind==='text' && <p className="workspace-notice">Preview limited to 256 KiB. Download the original for the complete file.</p>}
      {file?.kind==='text' && <div className="workspace-code"><SourceCode code={file.content || ''} language={file.language}/></div>}
      {file?.kind==='image' && (image ? <div className="workspace-image"><img src={image} alt={file.name}/></div> : !reading && <p className="workspace-empty">This image is too large to preview.</p>)}
      {file?.kind==='binary' && <div className="workspace-empty"><FileIcon/><h3>{file.name}</h3><p>{file.mimeType} · {size(file.size)}</p><p>This format is available as a download.</p>{!file.downloadable && <p>Downloads are limited to 32 MiB.</p>}</div>}
      {diff && <>{diff.truncated && <p className="workspace-notice">Diff preview limited to 256 KiB.</p>}{diff.binary ? <p className="workspace-empty">Binary file changed. Select File to inspect or download it.</p> : diff.diff ? <div className="workspace-code workspace-diff"><SourceCode code={diff.diff} language="diff"/></div> : <p className="workspace-empty">No {diff.mode==='staged'?'staged':'working'} changes for this file.</p>}</>}
    </section></div>
  </div>;
}

export function mountWorkspaceExplorer(element:HTMLElement,callbacks:WorkspaceCallbacks) {
  const root=createRoot(element);
  let active:string|null=null;
  return {setBot(botId:string){if(active===botId)return;active=botId;root.render(<Workspace key={botId} botId={botId} callbacks={callbacks}/>);},clear(){active=null;root.render(null);},destroy(){root.unmount();}};
}
