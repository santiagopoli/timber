// Stable identity colors shared by navigation, mentions and agent events.
export function agentColor(id:string):string {
  let hash=0;
  for(const character of id)hash=(Math.imul(hash,31)+character.charCodeAt(0))>>>0;
  return ['fern','iris','ocean','clay','rose','gold'][hash%6];
}
