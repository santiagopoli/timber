import type { AvatarTheme } from './avatars';

export interface AvatarThemePreset {
  id: string;
  slug: string;
  name: string;
  kind: 'vector' | 'image';
  style: string;
  subject?: string;
  description: string;
  examples: readonly string[];
}

const animals = ['Owl', 'Fox', 'Cat', 'Bear', 'Rabbit'];

/** Stable IDs make the collection additive and idempotent for existing owners. */
export const AVATAR_THEME_PRESETS: readonly AvatarThemePreset[] = [
  {
    id: 'bea70001-5a10-4000-8000-000000000001', slug: 'paperfold', name: 'Paperfold', kind: 'vector', subject: 'Animals',
    description: 'Crisp folds. Quiet, earthy color.', examples: animals,
    style: 'Minimal origami paper sculpture rendered as flat SVG polygons. Angular folded planes, warm ivory, terracotta, sage and ochre colors. Use a few contrasting flat facets to imply paper folds; no gradients, outlines or textures. Distinct silhouettes and tiny charcoal facial details.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000002', slug: 'bauhaus', name: 'Bauhaus', kind: 'vector', subject: 'Robots',
    description: 'Playful geometry. Primary colors.', examples: ['Orbit', 'Relay', 'Prism', 'Dial', 'Signal'],
    style: 'Bauhaus graphic design, bold geometric robot faces assembled from circles, rectangles and semicircles. Flat vermilion, cobalt blue, mustard yellow, cream and charcoal. Asymmetric but balanced compositions, clean shapes, expressive mechanical eyes. No gradients or realistic shading.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000003', slug: 'monoline', name: 'Monoline', kind: 'vector', subject: 'Animals',
    description: 'A few confident lines. Lots of character.', examples: animals,
    style: 'Elegant monoline animal face illustration. Consistent thick dark navy strokes with rounded caps and joins, sparse ivory fills and a tiny coral accent. Simple continuous-looking curves, generous negative space, clear eyes and expressive ears. No gradients or complex textures. Keep strokes legible at 32 pixels.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000004', slug: 'pixel', name: 'Pixel', kind: 'vector', subject: 'Adventurers',
    description: 'Tiny heroes from a 16-bit world.', examples: ['Ranger', 'Mage', 'Knight', 'Rogue', 'Healer'],
    style: 'Charming retro 16-bit RPG character portraits made from axis-aligned SVG rectangles and stepped polygons on a 16 by 16 pixel grid. Chunky square pixels, limited six-color palettes, dark outlines and hard-edged highlights. Distinct fantasy hats, helmets and hair. No curves, gradients, anti-aliased diagonals or background scene.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000005', slug: 'botanical', name: 'Botanical', kind: 'vector', subject: 'Forest spirits',
    description: 'Leafy faces with a little woodland magic.', examples: ['Fern', 'Acorn', 'Bloom', 'Moss', 'Sprout'],
    style: 'Whimsical forest-spirit faces in a clean flat botanical illustration style. Leaf-shaped ears, petal crowns or acorn caps integrated into the head silhouette. Sage, deep pine, moss green, terracotta and soft cream. Smooth organic paths, simple friendly dark eyes, occasional leaf-vein strokes, no gradients or external decorations.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000006', slug: 'clay', name: 'Clay', kind: 'image', subject: 'Animals',
    description: 'Soft clay, sculpted by hand.', examples: animals,
    style: 'Hand-sculpted matte polymer clay, rounded chunky forms, subtle fingertip texture, warm soft studio light. Mint teal, apricot, butter yellow and lilac palette. Artisan stop-motion character design; tactile and matte, not shiny plastic.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000007', slug: 'plush', name: 'Plush', kind: 'image', subject: 'Monsters',
    description: 'Fuzzy, stitched and wonderfully odd.', examples: ['Mint', 'Lilac', 'Peach', 'Butter', 'Sky'],
    style: 'Handmade felt and wool plush toy heads, fuzzy fibers, soft stitched seams and embroidered eyes. Cozy pastel cream, mint, peach, lavender and sky blue. Lovable expressive monster faces with unusual ears, little horns or different numbers of eyes. Studio product photography with tactile fiber detail.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000008', slug: 'porcelain', name: 'Porcelain', kind: 'image', subject: 'Animals',
    description: 'Ivory glaze and cobalt brushwork.', examples: animals,
    style: 'Exquisite glazed porcelain collectible heads, smooth ivory ceramic with hand-painted cobalt blue floral details and tiny warm gold accents. Elegant minimal shapes, realistic subtle glaze highlights and gallery object photography. Distinct readable facial features; ornament remains secondary to the silhouette.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000009', slug: 'watercolor', name: 'Watercolor', kind: 'image', subject: 'Animals',
    description: 'Airy washes. Expressive little faces.', examples: animals,
    style: 'Expressive hand-painted watercolor animal faces, translucent pigment washes, fine ink facial details, organic irregular edges and subtle pigment granulation within the silhouette. Terracotta, sage green, ultramarine and mustard. Airy editorial illustration, no 3D rendering and no paper rectangle behind the painting.',
  },
  {
    id: 'bea70001-5a10-4000-8000-000000000010', slug: 'space-toys', name: 'Space Toys', kind: 'image', subject: 'Robots',
    description: 'Retro-future collectibles, ready for orbit.', examples: ['Cosmo', 'Beacon', 'Radar', 'Nova', 'Comet'],
    style: 'Retro-futurist collectible vinyl robot heads. Glossy orange, silver, petrol blue, cream and mustard with small metallic antennae, bulbous helmets and expressive visors. Mid-century science fiction aesthetic, premium studio toy photography. Varied friendly mechanical faces with realistic material highlights.',
  },
];

export function avatarThemePrompt(style: string, subject?: string): string {
  return `Art style: ${style}\n${subject ? `Subject family: ${subject}. Choose a distinct member of this family that suits the bot.` : 'Subject: choose a distinctive character that suits the bot’s identity and purpose.'}\nHead only: a close-up face with complete ears, hair, horns or headwear. No body, shoulders, hands, props, text or letters. Center the whole head with comfortable padding so it fits inside a circular avatar. Prioritize a truly transparent background with no backdrop, enclosing circle, badge or frame, and no shadow outside the silhouette. Timber adds the solid colored circle in the UI; do not draw that circle in the artwork. Keep the face readable at 32 pixels and consistent with other heads in this theme.`;
}

export function builtinAvatarThemes(vectorModel = 'gpt-6.1-sol'): AvatarTheme[] {
  return AVATAR_THEME_PRESETS.map(preset => ({
    id: preset.id, name: `${preset.name}${preset.subject ? ` · ${preset.subject}` : ''}`,
    kind: preset.kind, style: preset.style, subject: preset.subject, preset: preset.slug,
    framing: 'circle', prompt: avatarThemePrompt(preset.style, preset.subject),
    model: preset.kind === 'image' ? 'gpt-image-2.5-sunburst' : vectorModel,
    createdAt: '2026-10-10T00:00:00.000Z',
  }));
}
