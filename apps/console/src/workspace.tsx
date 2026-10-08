import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BundledLanguage, ThemedToken } from 'shiki';
import { syntaxHighlighter } from './lib/syntax';
import { ArrowLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FolderIcon, GitBranchIcon, RefreshCwIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import './workspace.css';

type Entry = {name:string;path:string;kind:'file'|'directory'|'symlink';size:number;accessible:boolean};
type Tree = {path:string;entries:Entry[];truncated:boolean};
type FileView = {path:string;name:string;size:number;mimeType:string;kind:'text'|'image'|'binary';content?:string;language?:string;truncated:boolean;downloadable:boolean};
type Project = {path:string;name:string;branch:string|null;head:string|null;detached:boolean;dirty:boolean;staged:number;unstaged:number;untracked:number;error?:string};
type Change = {path:string;previousPath?:string;indexStatus:string;worktreeStatus:string;staged:boolean;unstaged:boolean;untracked:boolean};
type Diff = {project:string;path:string;mode:string;diff:string;truncated:boolean;binary:boolean};
export type WorkspaceCallbacks = {
  request(botId:string,path:string,signal?:AbortSignal):Promise<unknown>;
  download(botId:string,path:string,signal?:AbortSignal):Promise<Response>;
};
const query = (route:string,values:Record<string,string>) => `/workspace/${route}?${new URLSearchParams(values)}`;
const size = (bytes:number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes/1024).toFixed(1)} KiB` : `${(bytes/1024**2).toFixed(1)} MiB`;
const parent = (path:string) => path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : '.';
const join = (root:string,path:string) => root === '.' ? path : `${root}/${path}`;
type LoadState = 'loading'|'ready'|'error';
const safeImages = new Set(['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp','image/x-icon']);

function SourceCode({code,language='text'}:{code:string;language?:string}) {
  const [highlight,setHighlight]=useState<{code:string;language:string;tokens:ThemedToken[][]}|null>(null);
  useEffect(()=>{
    let active=true;
    void syntaxHighlighter(language).then(engine=>{
      const selected=engine.getLoadedLanguages().includes(language)?language:'text';
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
  const [treeState,setTreeState] = useState<LoadState>('loading'), [projectsState,setProjectsState] = useState<LoadState>('loading'), [changesState,setChangesState] = useState<LoadState>('ready');
  const [treeError,setTreeError] = useState(''), [projectsError,setProjectsError] = useState(''), [changesError,setChangesError] = useState('');
  const [reading,setReading] = useState(false), [mode,setMode] = useState<'files'|'changes'>('files');
  const [previewPath,setPreviewPath] = useState<string|null>(null);
  const busy = treeState==='loading' || projectsState==='loading' || changesState==='loading';
  const [limited,setLimited] = useState(false), [tab,setTab] = useState<'file'|'unstaged'|'staged'>('file');
  const alive = useRef(true), navigation = useRef(0), selection = useRef(0), objectURL = useRef<string | null>(null), projectGeneration = useRef(0), scanGeneration = useRef(0), controller = useRef<AbortController|null>(null);
  const previewBack = useRef<HTMLButtonElement>(null), selectionTrigger = useRef<HTMLElement|null>(null);
  const releaseImage = () => {if (objectURL.current) URL.revokeObjectURL(objectURL.current); objectURL.current=null; setImage(null);};
  const closeFile = () => {selection.current++;releaseImage();setFile(null);setDiff(null);setPreviewPath(null);setReading(false);setError('');requestAnimationFrame(()=>selectionTrigger.current?.focus({preventScroll:true}));};
  const message = (err:unknown) => err instanceof Error ? err.message : 'Workspace could not be loaded. Refresh to try again.';
  const report = (err:unknown) => {if (alive.current) setError(message(err));};
  const request = <T,>(route:string) => callbacks.request(botId,route,controller.current?.signal) as Promise<T>;
  const loadTree = async (path='.') => {
    const generation=++navigation.current;setTreeState('loading');setTreeError('');
    if(tree?.path!==path)setTree(null);
    try {
      const data=await request<Tree>(query('tree',{path}));
      if(!data || typeof data.path!=='string' || !Array.isArray(data.entries))throw new Error('The server returned an invalid file list. Refresh to try again.');
      if(alive.current && generation===navigation.current){setTree(data);setTreeState('ready');}
    } catch(err){if(alive.current && generation===navigation.current){setTreeError(message(err));setTreeState('error');}}
  };
  const loadProjects = async () => {
    const generation=++scanGeneration.current;setProjectsState('loading');setProjectsError('');
    try {
      const data=await request<{projects:Project[];truncated:boolean}>('/workspace/projects');
      if(!data || !Array.isArray(data.projects))throw new Error('The server returned an invalid project list. Refresh to try again.');
      if(alive.current && generation===scanGeneration.current){setProjects(data.projects);setLimited(data.truncated);setProjectsState('ready');}
    } catch(err){if(alive.current && generation===scanGeneration.current){setProjectsError(message(err));setProjectsState('error');}}
  };
  const chooseProject = async (value:Project) => {
    closeFile();
    setProject(value);setMode('changes');setChanges([]);setChangesError('');setChangesState('loading');
    const generation=++projectGeneration.current;
    try {
      const data=await request<{changes:Change[];truncated:boolean}>(query('changes',{project:value.path}));
      if(!data || !Array.isArray(data.changes))throw new Error('The server returned an invalid change list. Refresh to try again.');
      if(alive.current && generation===projectGeneration.current){setChanges(data.changes);setLimited(data.truncated);setChangesState('ready');}
    } catch(err){if(alive.current && generation===projectGeneration.current){setChangesError(message(err));setChangesState('error');}}
  };
  const openFile = async (path:string,view:'file'|'unstaged'|'staged'='file',source=project) => {
    if(document.activeElement instanceof HTMLElement && document.activeElement.closest('.workspace-sidebar'))selectionTrigger.current=document.activeElement;
    const generation=++selection.current; releaseImage();setFile(null);setDiff(null);setPreviewPath(view!=='file' && source?join(source.path,path):path);setTab(view);setReading(true);setError('');
    try {
      if(view!=='file' && source){
        const data=await request<Diff>(query('diff',{project:source.path,path,mode:view}));
        if(alive.current && generation===selection.current)setDiff(data);
      } else {
        const data=await request<FileView>(query('file',{path}));
        if(!alive.current || generation!==selection.current)return;
        setFile(data);
        if(data.kind==='image' && safeImages.has(data.mimeType) && data.downloadable){
          const response=await callbacks.download(botId,query('download',{path}),controller.current?.signal);
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
    try {const response=await callbacks.download(botId,query('download',{path:file.path}),controller.current?.signal);if(!response.ok)throw new Error('File could not be downloaded.');const blob=await response.blob();if(!alive.current)return;const url=URL.createObjectURL(new Blob([blob],{type:'application/octet-stream'}));const link=document.createElement('a');link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    catch(err){report(err);}
  };
  useEffect(()=>{alive.current=true;controller.current=new AbortController();void loadTree();void loadProjects();return()=>{alive.current=false;controller.current?.abort();navigation.current++;selection.current++;projectGeneration.current++;scanGeneration.current++;if(objectURL.current)URL.revokeObjectURL(objectURL.current);};},[botId]);
  useEffect(()=>{if(previewPath && window.matchMedia('(max-width: 760px)').matches)previewBack.current?.focus({preventScroll:true});},[previewPath]);
  const selectedPath = previewPath;
  const selectedChange = project && selectedPath ? changes.find(c=>join(project.path,c.path)===selectedPath) : undefined;
  const breadcrumbs = tree?.path === '.' ? [] : tree?.path.split('/') ?? [];
  return <div className="timber-workspace" data-workspace-explorer data-preview-open={previewPath!==null}>
    <header className="workspace-heading"><h2>Workspace</h2><button type="button" className="workspace-refresh" aria-label="Refresh workspace" title="Refresh workspace" onClick={()=>{void loadTree(tree?.path);void loadProjects();if(project)void chooseProject(project);}} disabled={busy}><RefreshCwIcon className={busy?'workspace-loading-icon':undefined}/><span>Refresh</span></button></header>
    <div className="workspace-projects" aria-label="Git projects" aria-busy={projectsState==='loading'}>{projects.map(p=><button type="button" key={p.path} title={p.path} aria-pressed={project?.path===p.path} className={`workspace-project ${project?.path===p.path?'selected':''}`} onClick={()=>void chooseProject(p)}><span className="workspace-project-name"><span>{p.name}</span>{!p.error && <small title={`${p.staged} staged · ${p.unstaged} modified · ${p.untracked} untracked`}>{p.dirty?'Changed':'Clean'}</small>}</span><span className="workspace-project-branch"><GitBranchIcon/><span>{p.error || (p.detached ? `Detached · ${p.head?.slice(0,7) || 'unknown'}` : p.branch || 'New repository')}</span></span></button>)}{projectsState==='loading' && <span className="workspace-loading workspace-muted" role="status"><LoaderCircleIcon/>Loading projects…</span>}{projectsState==='error' && <span className="workspace-error" role="alert">{projectsError}</span>}{projectsState==='ready' && !projects.length && <span className="workspace-muted">No Git projects in /workspace.</span>}</div>
    {limited && <p className="workspace-notice">The workspace scan reached its limit. Open a project folder to inspect files directly.</p>}
    <div className="workspace-layout"><aside className="workspace-sidebar"><div className="workspace-modes"><button type="button" aria-pressed={mode==='files'} onClick={()=>setMode('files')}>Files</button><button type="button" aria-pressed={mode==='changes'} disabled={!project} onClick={()=>setMode('changes')}>Changes {project ? `(${changes.length})` : ''}</button></div>
      {mode==='files' ? <><nav className="workspace-breadcrumbs" aria-label="Workspace folders"><button type="button" onClick={()=>void loadTree('.')}>workspace</button>{breadcrumbs.map((part,index)=><span key={index}><ChevronRightIcon/><button type="button" onClick={()=>void loadTree(breadcrumbs.slice(0,index+1).join('/'))}>{part}</button></span>)}</nav><div className="workspace-file-list" aria-busy={treeState==='loading'}>{treeState==='loading' && <p className="workspace-loading workspace-muted" role="status"><LoaderCircleIcon/>Loading files…</p>}{treeState==='error' && <p className="workspace-error" role="alert">{treeError}</p>}{tree?.path!=='.' && tree && <button type="button" className="workspace-entry" onClick={()=>void loadTree(parent(tree.path))}><FolderIcon/>..</button>}{tree?.entries.map(entry=><button type="button" className={`workspace-entry ${selectedPath===entry.path?'selected':''}`} key={entry.path} title={entry.accessible ? entry.path : 'Symbolic links and special files cannot be opened'} disabled={!entry.accessible} onClick={()=>entry.kind==='directory'?void loadTree(entry.path):void openFile(entry.path)}>{entry.kind==='directory'?<FolderIcon/>:<FileIcon/>}<span>{entry.name}{entry.kind==='symlink'?' ↗':''}</span>{entry.kind==='file' && <small>{size(entry.size)}</small>}</button>)}{treeState==='ready' && tree && !tree.entries.length && <p className="workspace-muted">This folder is empty.</p>}{tree?.truncated && <p className="workspace-notice">Showing the first 2,000 entries.</p>}</div></> : <div className="workspace-changes" aria-busy={changesState==='loading'}><p className="workspace-project-label">{project?.path}</p>{changesState==='loading' && <p className="workspace-loading workspace-muted" role="status"><LoaderCircleIcon/>Loading changes…</p>}{changesState==='error' && <p className="workspace-error" role="alert">{changesError}</p>}{changes.map(change=><button type="button" className={`workspace-entry ${selectedPath===join(project!.path,change.path)?'selected':''}`} key={change.path} title={change.previousPath?`${change.previousPath} → ${change.path}`:change.path} onClick={()=>void openFile(change.path,change.unstaged||change.untracked?'unstaged':'staged')}><span className="workspace-git-status">{change.untracked?'U':`${change.indexStatus}${change.worktreeStatus}`.trim()}</span><span>{change.path}</span></button>)}{changesState==='ready' && !changes.length && <p className="workspace-muted">No changes in this project.</p>}</div>}
    </aside><section className="workspace-viewer" aria-label="File preview" aria-busy={reading}>{previewPath && <div className="workspace-file-toolbar"><button ref={previewBack} type="button" className="workspace-back" aria-label={`Back to ${mode}`} onClick={closeFile}><ArrowLeftIcon/></button><strong title={previewPath}>{previewPath}</strong>{file && <span>{size(file.size)}</span>}{file?.downloadable && <button type="button" aria-label="Download file" onClick={()=>void download()}><DownloadIcon/></button>}<button type="button" className="workspace-close" aria-label="Close file" onClick={closeFile}><XIcon/></button></div>}
      {selectedChange && <div className="workspace-file-tabs"><button type="button" aria-pressed={tab==='file'} onClick={()=>void openFile(selectedPath!)}>File</button><button type="button" disabled={!selectedChange.unstaged && !selectedChange.untracked} aria-pressed={tab==='unstaged'} onClick={()=>void openFile(selectedChange.path,'unstaged')}>Working changes</button><button type="button" disabled={!selectedChange.staged} aria-pressed={tab==='staged'} onClick={()=>void openFile(selectedChange.path,'staged')}>Staged changes</button></div>}
      {reading && <div className="workspace-empty" role="status">Loading preview…</div>}
      {error && <div className="workspace-error" role="alert">{error}</div>}
      {!reading && !previewPath && <div className="workspace-empty"><FileIcon/><h3>Select a file</h3></div>}
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
  let active:string|null=null,revision=0;
  return {setBot(botId:string){if(active===botId)return;active=botId;root.render(<Workspace key={`${botId}:${++revision}`} botId={botId} callbacks={callbacks}/>);},clear(){active=null;root.render(null);},destroy(){root.unmount();}};
}
