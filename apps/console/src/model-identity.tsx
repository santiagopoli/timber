/** A compact identifier, not a capability or a provider availability claim. */
export function modelBadgeLabel(model: string): string {
  const id=model.split('/').at(-1)||model;
  const gpt=/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(id);
  if(gpt)return `${gpt[1]}${gpt[2]?.split('-').map(part=>part[0]?.toUpperCase()).join('')||''}`.slice(0,6);
  const words=id.split(/[-_\s]+/).filter(Boolean),version=words.find(word=>/^\d/.test(word));
  return (version?`${words[0][0].toUpperCase()}${version}`:words.length>1?words.map(word=>word[0]).join('').toUpperCase():id).slice(0,6);
}

export function ModelBadge({model}: {model?:string}) {
  return model?<span className="timber-model-badge" data-model={model} title={model} aria-hidden="true">{modelBadgeLabel(model)}</span>:null;
}
