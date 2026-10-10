/// <reference types="vite/client" />
import { AVATAR_THEME_PRESETS } from '../../../packages/contracts/src/avatar-presets';
import type { AvatarTheme } from '../../../packages/contracts/src/avatars';
import { prepareAvatarPreview } from './avatar-framing';
import './avatar-theme-gallery.css';

const colors = ['#e1e9df', '#f0dfd1', '#e7e1ef', '#eee7ce', '#dce8ec'];
const assetBase = `${import.meta.env.BASE_URL}avatar-themes/`;

/** Public, curated examples: browsing never generates an avatar or calls a model. */
export function renderAvatarThemeGallery(container: HTMLElement, options: {
  themes: AvatarTheme[]; selectedId: string; currentId?: string; busy: boolean;
  onSelect: (id: string) => void;
}): void {
  const signature = JSON.stringify([options.themes.map(t => t.id), options.selectedId, options.currentId, options.busy]);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  const activeSlug = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-theme-preset]')?.dataset.themePreset;
  const groups = document.createDocumentFragment();
  for (const kind of ['vector', 'image'] as const) {
    const group = document.createElement('section'); group.className = 'avatar-theme-group'; group.dataset.kind = kind;
    const heading = document.createElement('h4'); heading.textContent = kind === 'vector' ? 'SVG collection' : 'Image collection'; group.append(heading);
    for (const preset of AVATAR_THEME_PRESETS.filter(p => p.kind === kind)) {
      const theme = options.themes.find(t => t.id === preset.id);
      if (!theme) continue;
      const card = document.createElement('button'); card.type = 'button'; card.className = 'avatar-theme-card'; card.dataset.themePreset = preset.slug;
      card.disabled = options.busy;
      card.setAttribute('aria-pressed', String(options.selectedId === theme.id));
      card.setAttribute('aria-label', `${preset.name}${preset.subject ? ` · ${preset.subject}` : ''}, ${kind === 'vector' ? 'SVG' : 'image'} theme`);
      const title = document.createElement('span'); title.className = 'avatar-theme-card-heading';
      const name = document.createElement('strong'); name.textContent = preset.name; title.append(name);
      if (preset.subject) { const subject = document.createElement('span'); subject.className = 'avatar-theme-subject'; subject.textContent = preset.subject; title.append(subject); }
      const badge = document.createElement('span'); badge.className = 'avatar-theme-badge'; badge.textContent = options.currentId === theme.id ? 'Applied' : kind === 'vector' ? 'SVG' : 'Image'; title.append(badge);
      const samples = document.createElement('span'); samples.className = 'avatar-theme-samples';
      preset.examples.forEach((label, index) => {
        const sample = document.createElement('span'); sample.className = 'avatar-theme-sample'; sample.style.backgroundColor = colors[index];
        const art = document.createElement('span'); art.className = 'avatar-sample-art';
        const image = document.createElement('img'); image.alt = `${label} · ${preset.name}`; image.loading = 'lazy'; image.decoding = 'async';
        image.onload = () => { image.onload = null; prepareAvatarPreview(image, kind, index); };
        image.src = `${assetBase}${preset.slug}${kind === 'vector' ? `-${index + 1}.svg` : '.png'}`;
        art.append(image); sample.append(art); samples.append(sample);
      });
      const description = document.createElement('span'); description.className = 'avatar-theme-description'; description.textContent = preset.description;
      card.append(title, samples, description); card.addEventListener('click', () => options.onSelect(theme.id)); group.append(card);
    }
    if (group.childElementCount > 1) groups.append(group);
  }
  container.replaceChildren(groups);
  if (activeSlug) container.querySelector<HTMLButtonElement>(`[data-theme-preset="${activeSlug}"]`)?.focus({preventScroll: true});
}
