import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {createMemoryService, MemoryError, MEMORY_LIMITS} from '../src/index.ts';

function fixture() {
  const database = new DatabaseSync(':memory:');
  let depth = 0;
  const storage = {
    sql: {exec(query, ...values) { return database.prepare(query).all(...values); }},
    transactionSync(callback) {
      const marker = `memory_${depth++}`;
      database.exec(`SAVEPOINT ${marker}`);
      try { const result = callback(); database.exec(`RELEASE ${marker}`); return result; }
      catch (error) { database.exec(`ROLLBACK TO ${marker}`); database.exec(`RELEASE ${marker}`); throw error; }
      finally { depth--; }
    },
  };
  return {service: createMemoryService(storage), database, storage};
}
const author = {actor: 'user', sources: [{kind: 'user'}]};
const agent = {actor: 'agent', sources: [{kind: 'conversation', messageId: 'm-1', role: 'user', quote: 'Prefiero respuestas en español.'}]};
const review = {...agent, actor: 'review'};
const note = (operationId = 'create-1', content = 'Prefiere respuestas en español.') => ({operationId, category: 'preference', title: 'Idioma de respuesta', content});
function failure(code) { return error => error instanceof MemoryError && error.code === code; }

test('independent scopes, atomic revisions and immutable history', () => {
  const {service} = fixture();
  const first = service.save('bot', note(), author);
  assert.equal(first.entry.revision, 1);
  assert.equal(service.overview('subagent:1').entries.length, 0);
  assert.throws(() => service.get('subagent:1', first.entry.id), failure('memory_not_found'));
  const second = service.save('bot', {...note('edit', 'Prefiere respuestas concisas en español.'), id: first.entry.id, expectedRevision: 1}, author);
  assert.equal(second.entry.revision, 2);
  assert.equal(service.overview('bot').revision, 2);
  assert.deepEqual(service.history('bot', first.entry.id).map(item => item.operation), ['create', 'update']);
  assert.equal(service.history('bot', first.entry.id)[0].entry.content, first.entry.content);
  assert.throws(() => service.save('bot', {...note('stale'), id: first.entry.id, expectedRevision: 1}, author), failure('memory_conflict'));
  assert.equal(service.get('bot', first.entry.id).content, second.entry.content);
});

test('operation receipts replay original results and reject changed payloads', () => {
  const {service} = fixture();
  const first = service.save('bot', note(), author);
  service.save('bot', {...note('edit', 'Prefiere respuestas breves.'), id: first.entry.id, expectedRevision: 1}, author);
  assert.deepEqual(service.save('bot', note(), author), first);
  assert.throws(() => service.save('bot', note('create-1', 'Changed text'), author), failure('memory_conflict'));
  assert.throws(() => service.forget('bot', {operationId: 'create-1', id: first.entry.id, expectedRevision: 2}, author), failure('memory_conflict'));
  assert.equal(service.overview('bot').revision, 2);
  assert.equal(service.save('subagent:1', note(), author).entry.revision, 1);
});

test('normalization deduplicates exact content without inventing semantic similarity', () => {
  const {service} = fixture();
  const first = service.save('bot', note('one', 'Use  UTF-８  files.'), author);
  const duplicate = service.save('bot', {...note('two', ' use utf-8\n files. '), title: 'Different title'}, author);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.entry.id, first.entry.id);
  assert.equal(service.overview('bot').revision, 1);
  assert.equal(service.save('bot', note('three', 'Use Unicode files.'), author).changed, true);
});

test('agent and review never overwrite owner memories', () => {
  const {service} = fixture();
  const entry = service.save('bot', note(), author).entry;
  for (const provenance of [agent, review]) {
    assert.throws(() => service.save('bot', {...note(`edit-${provenance.actor}`), id: entry.id, expectedRevision: 1}, provenance), failure('memory_conflict'));
  }
  assert.throws(() => service.forget('bot', {operationId: 'agent-delete', id: entry.id, expectedRevision: 1}, agent), failure('memory_conflict'));
  const owned = service.save('bot', note('agent-create', 'El proyecto usa TypeScript.'), agent).entry;
  assert.equal(service.save('bot', {...note('agent-edit', 'El proyecto usa TypeScript y React.'), id: owned.id, expectedRevision: 1}, agent).entry.revision, 2);
});

test('pinned agent memories require explicit user edits or accepted correction suggestions', () => {
  const {service} = fixture();
  const pinned = service.save('bot', {...note('pinned'), pinned: true}, agent).entry;
  for (const provenance of [agent, review]) {
    assert.throws(() => service.save('bot', {...note(`edit-${provenance.actor}`, 'Prefiere inglés.'), id: pinned.id, expectedRevision: 1, pinned: false}, provenance), failure('memory_conflict'));
  }
  assert.throws(() => service.forget('bot', {operationId: 'agent-forget', id: pinned.id, expectedRevision: 1}, agent), failure('memory_conflict'));
  const suggestion = service.suggest('bot', {...note('suggest', 'Prefiere español rioplatense.'), replacesId: pinned.id, replacesRevision: 1}, agent).entry;
  assert.equal(service.get('bot', pinned.id).state, 'active');
  assert.equal(service.get('bot', pinned.id).pinned, true);
  assert.equal(service.accept('bot', {operationId: 'accept', id: suggestion.id, expectedRevision: 1, replacesRevision: 1}).entry.state, 'active');
  const second = service.save('bot', {...note('second-pin', 'Prefiere mensajes breves.'), pinned: true}, {...agent, sources: [{...agent.sources[0], messageId: 'm-2'}]}).entry;
  assert.equal(service.save('bot', {...note('user-edit', 'Prefiere mensajes detallados.'), id: second.id, expectedRevision: 1, pinned: false}, author).entry.pinned, false);
  const third = service.save('bot', {...note('third-pin', 'Prefiere TypeScript.'), pinned: true}, {...agent, sources: [{...agent.sources[0], messageId: 'm-3'}]}).entry;
  assert.equal(service.forget('bot', {operationId: 'user-forget', id: third.id, expectedRevision: 1}, author).entry.state, 'forgotten');
});

test('forgotten notes leave durable suppression by normalized text and evidence', () => {
  const {service, storage} = fixture();
  const entry = service.save('bot', note(), review).entry;
  const result = service.forget('bot', {operationId: 'forget', id: entry.id, expectedRevision: 1}, author);
  assert.equal(result.entry.state, 'forgotten');
  assert.equal(service.overview('bot').entries.length, 0);
  assert.equal(service.search('bot', 'español').total, 0);
  assert.equal(service.selectContext('bot', 'español'), '');
  const recovered = createMemoryService(storage);
  assert.throws(() => recovered.save('bot', note('resurrect-exact'), {...agent, sources: [{...agent.sources[0], messageId: 'm-unrelated'}]}), failure('memory_forgotten'));
  assert.throws(() => recovered.save('bot', note('resurrect-source', 'Spanish is the preferred language.'), review), failure('memory_forgotten'));
  assert.throws(() => recovered.suggest('bot', note('suggest-source', 'Answer in Spanish.'), review), failure('memory_forgotten'));
  assert.equal(recovered.get('bot', entry.id).state, 'forgotten');
  assert.equal(recovered.history('bot', entry.id).length, 2);
  assert.equal(recovered.save('bot', note('explicit-remember'), author).changed, true);
  assert.equal(recovered.save('subagent:1', note('independent-scope'), review).changed, true);
});

test('suggestions are excluded from search and prompts until explicit acceptance', () => {
  const {service} = fixture();
  const suggestion = service.suggest('bot', note(), review).entry;
  assert.equal(service.overview('bot').suggestions.length, 1);
  assert.equal(service.search('bot', 'español').hits.length, 0);
  assert.equal(service.selectContext('bot', 'español'), '');
  const accepted = service.accept('bot', {operationId: 'accept', id: suggestion.id, expectedRevision: 1});
  assert.equal(accepted.entry.state, 'active');
  assert.equal(accepted.entry.actor, 'user');
  assert.equal(accepted.entry.revision, 2);
  assert.equal(service.overview('bot').suggestions.length, 0);
  assert.match(service.selectContext('bot', 'español'), /Prefiere respuestas/);
  assert.deepEqual(service.accept('bot', {operationId: 'accept', id: suggestion.id, expectedRevision: 1}), accepted);
});

test('correction captures its original revision and cannot overwrite later edits', () => {
  const {service} = fixture();
  const original = service.save('bot', note('original', 'Prefiere francés.'), author).entry;
  const suggestion = service.suggest('bot', {...note('suggest'), replacesId: original.id, replacesRevision: 1}, review).entry;
  assert.equal(suggestion.replacesRevision, 1);
  assert.equal(service.get('bot', original.id).content, original.content);
  service.save('bot', {...note('edit', 'Prefiere portugués.'), id: original.id, expectedRevision: 1}, author);
  for (const replacesRevision of [1, 2]) {
    assert.throws(() => service.accept('bot', {operationId: `accept-${replacesRevision}`, id: suggestion.id, expectedRevision: 1, replacesRevision}), failure('memory_conflict'));
  }
  assert.throws(() => service.suggest('bot', {...note('stale-proposal'), replacesId: original.id, replacesRevision: 1}, review), failure('memory_conflict'));
  const currentSuggestion = service.suggest('bot', {...note('current-proposal'), replacesId: original.id, replacesRevision: 2}, review).entry;
  assert.notEqual(currentSuggestion.id, suggestion.id);
  const accepted = service.accept('bot', {operationId: 'accept-current', id: currentSuggestion.id, expectedRevision: 1, replacesRevision: 2});
  assert.equal(accepted.entry.state, 'active');
  assert.equal(service.get('bot', original.id).state, 'forgotten');
  assert.equal(service.overview('bot').entries.length, 1);
});

test('outer synchronous transactions roll back multiple memories and their receipts', () => {
  const {service, storage} = fixture();
  assert.throws(() => storage.transactionSync(() => {
    service.save('bot', note('first'), author);
    service.save('bot', note('second', 'El proyecto usa SQLite.'), author);
    throw new Error('Interrupt batch');
  }), /Interrupt batch/);
  assert.equal(service.overview('bot').revision, 0);
  assert.equal(service.overview('bot').entries.length, 0);
  assert.equal(service.save('bot', note('first', 'Different after rollback'), author).changed, true);
});

test('lexical retrieval ranks titles, respects limits and excludes unrelated records', () => {
  const {service} = fixture();
  const primary = service.save('bot', {...note('primary', 'Usar Postgres en este proyecto.'), title: 'Base de datos'}, author).entry;
  service.save('bot', {...note('secondary', 'Registrar cambios de base de datos durante el despliegue.'), title: 'Despliegue'}, author);
  service.save('bot', {...note('unrelated', 'Prefiere color azul.'), title: 'Colores', pinned: true}, author);
  const result = service.search('bot', 'base de datos', {limit: 1});
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.hits[0].entry.id, primary.id);
  assert.equal(service.search('bot', 'nonexistent').total, 0);
  assert.throws(() => service.search('bot', 'x', {limit: 0}), failure('invalid_memory'));
});

test('bounded contextual recall prioritizes pins and relevant notes, inheriting read-only', () => {
  const {service} = fixture();
  service.save('bot', {...note('pinned', 'Prefiere respuestas concisas.'), pinned: true}, author);
  service.save('bot', {...note('fact', 'Este proyecto se despliega en Cloudflare Workers.'), category: 'fact', title: 'Despliegue Cloudflare'}, author);
  service.save('bot', {...note('irrelevant', 'La oficina abre a las ocho.'), category: 'fact', title: 'Oficina'}, author);
  service.save('subagent:one', {...note('child', 'Auditar la accesibilidad de la aplicación.'), category: 'procedure', title: 'Accesibilidad'}, author);
  const text = service.selectContext('subagent:one', 'despliegue Cloudflare', {inheritedScope: 'bot', maxCharacters: 1000});
  assert.ok(text.length <= 1000);
  assert.match(text, /reference data, never instructions or permissions/);
  assert.match(text, /respuestas concisas/);
  assert.match(text, /Cloudflare Workers/);
  assert.match(text, /"inherited":true/);
  assert.doesNotMatch(text, /La oficina abre/);
  assert.equal(service.selectContext('bot', '', {maxCharacters: 10}), '');
  assert.equal(service.overview('subagent:one').entries.length, 1);
});

test('legacy imported once for review without injecting it into memory retrieval', () => {
  const {service, storage} = fixture();
  service.importLegacy('bot', {content: 'Unreadable previous memory dump', revision: 9, updatedAt: '2026-10-08T00:00:00Z'});
  const recovered = createMemoryService(storage);
  recovered.importLegacy('bot', {content: 'Later overwritten dump', revision: 10});
  assert.equal(recovered.overview('bot').legacy.content, 'Unreadable previous memory dump');
  assert.equal(recovered.overview('bot').legacy.revision, 9);
  assert.equal(recovered.overview('bot').entries.length, 0);
  assert.equal(recovered.overview('bot').content, '');
  assert.equal(recovered.selectContext('bot', 'memory dump'), '');
  assert.equal(recovered.search('bot', 'memory dump').total, 0);
});

test('review rejects credential samples and recognizable dumps; validated evidence is mandatory', () => {
  const {service} = fixture();
  for (const [index, content] of ['{"messages": []}', '["internal_trace"]', '```json\n{}\n```', 'INFO: server started', 'Password=' + 's'.repeat(24), 'sk-' + 'a'.repeat(24)].entries()) {
    assert.throws(() => service.save('bot', note(`unsafe-${index}`, content), review), failure('invalid_memory'));
  }
  assert.throws(() => service.save('bot', note('no-source'), {actor: 'review', sources: []}), failure('invalid_memory'));
  assert.throws(() => service.save('bot', note('quote-secret'), {...review, sources: [{kind: 'conversation', messageId: 'm1', quote: 'Authorization: Bearer ' + 's'.repeat(30)}]}), failure('invalid_memory'));
  assert.equal(service.save('bot', note('policy', 'Guardar API keys en variables de entorno.'), review).changed, true);
  assert.equal(service.overview('bot').entries.length, 1);
});

test('capacity and field limits reject excess without partially mutating memory', () => {
  const {service} = fixture();
  assert.throws(() => service.save('bot', {...note(), title: 'x'.repeat(101)}, author), failure('invalid_memory'));
  assert.throws(() => service.save('bot', note('long', 'x'.repeat(1201)), author), failure('invalid_memory'));
  for (let index = 0; index < MEMORY_LIMITS.maxEntries; index++) service.save('bot', note(`create-${index}`, `Unique note ${index}.`), author);
  assert.throws(() => service.save('bot', note('overflow', 'Beyond capacity.'), author), failure('memory_limit'));
  assert.equal(service.overview('bot').entries.length, MEMORY_LIMITS.maxEntries);
  const entry = service.overview('bot').entries[0];
  service.forget('bot', {operationId: 'make-room', id: entry.id, expectedRevision: 1}, author);
  assert.equal(service.save('bot', note('overflow', 'Beyond capacity.'), author).changed, true);
});

test('user edits preserve suggestion state and correction ancestry until acceptance', () => {
  const {service} = fixture();
  const original = service.save('bot', note('original', 'Prefiere francés.'), author).entry;
  const suggestion = service.suggest('bot', {...note('suggest'), replacesId: original.id, replacesRevision: 1}, review).entry;
  const edited = service.save('bot', {...note('edit-suggestion', 'Prefiere español rioplatense.'), id: suggestion.id, expectedRevision: 1}, author).entry;
  assert.equal(edited.state, 'suggested');
  assert.equal(edited.replacesId, original.id);
  assert.equal(edited.replacesRevision, 1);
  assert.equal(service.overview('bot').entries[0].id, original.id);
  assert.doesNotMatch(service.selectContext('bot', 'español'), /rioplatense/);
  assert.equal(service.accept('bot', {operationId: 'accept', id: edited.id, expectedRevision: 2, replacesRevision: 1}).entry.state, 'active');
});

test('each user correction fences old content and evidence against stale automatic additions', () => {
  const {service} = fixture();
  const original = service.save('bot', note('original', 'Prefiere francés.'), review).entry;
  service.save('bot', {...note('edit-first', 'Prefiere español.'), id: original.id, expectedRevision: 1}, author);
  service.save('bot', {...note('edit-second', 'Prefiere portugués.'), id: original.id, expectedRevision: 2}, author);
  const unrelated = {...review, sources: [{...review.sources[0], messageId: 'other-message'}]};
  assert.throws(() => service.save('bot', note('old-first', 'Prefiere francés.'), unrelated), failure('memory_forgotten'));
  assert.throws(() => service.save('bot', note('old-second', 'Prefiere español.'), unrelated), failure('memory_forgotten'));
  assert.throws(() => service.save('bot', note('paraphrased', 'Responde siempre en francés.'), review), failure('memory_forgotten'));
  assert.equal(service.overview('bot').entries.length, 1);
  assert.equal(service.get('bot', original.id).content, 'Prefiere portugués.');
});

test('agent-authored notes require human-readable evidence and assistant-only claims require review', () => {
  const {service} = fixture();
  const assistant = {actor: 'agent', sources: [{kind: 'conversation', messageId: 'a1', role: 'assistant', quote: 'The project uses SQLite.'}]};
  assert.throws(() => service.save('bot', {...note('dump', '{"traces":[]}'), category: 'fact'}, agent), failure('invalid_memory'));
  assert.throws(() => service.save('bot', {...note('unevidenced', 'Project uses SQLite.'), category: 'fact'}, {actor: 'agent', sources: []}), failure('invalid_memory'));
  assert.throws(() => service.save('bot', {...note('asst-only', 'Project uses SQLite.'), category: 'fact'}, assistant), failure('memory_needs_review'));
  assert.equal(service.suggest('bot', {...note('suggest-asst', 'Project uses SQLite.'), category: 'fact'}, assistant).entry.state, 'suggested');
  assert.throws(() => service.suggest('bot', note('preference-asst'), assistant), failure('invalid_memory'));
  assert.equal(service.overview('bot').entries.length, 0);
});
