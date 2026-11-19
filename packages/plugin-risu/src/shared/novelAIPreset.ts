export const novelAIPreset = {
  positive: `1.35::very aesthetic, masterpiece, amazing quality, absurdres, ultra-detailed, highres::, {year 2026}, ::newest::, enhanced visuals, 1.2::semi-realistic, ink wash style::, 1.1::fine lineart, delicate linework, detailed linework::, 1.05::cinematic illustration, key art::, 1.05::detailed skin, realistic skin texture, fair skin::, 1.15::subsurface scattering, soft skin glow::, [[shiny skin]], 1.05::soft shading, gentle shading, subtle ambient occlusion::, ::perfect anatomy, perfect proportions::, intricate details,
1.15::artist:re0n::,0.95::artist:wo_jiushi_kanbudong::,0.85::artist:ushikani_kassen::,::artist:murata_yuusuke::,0.75::artist:xiaobanbei_milk::,0.65::artist:nixeu::,0.55::artist:oda_non::,0.6::artist:taesi::,0.6::artist:dishwasher1910,::,0.8::artist:inoitoh::,
1.1::realistic lighting, depth of field, depthness::, no text,`,
  negative:
    "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, bad anatomy, bad proportions, bad hands, extra fingers, missing fingers, fused fingers, too many fingers, fewer fingers, poorly drawn hands, bad feet, extra toes, missing toes, fused toes, poorly drawn feet, extra limbs, missing limbs, fused limbs, malformed limbs, disconnected limbs, low detail, blurry, flat face, 2d face, simple face, round childish face, overly wide face, square jaw, large nose, thick lips, chibi, cartoonish proportions, flat eyes, empty eyes, triangle nose, dot nose, button nose, flat nose, pig nose, western face, european face, disproportional philtrum, out of focus, low sharpness, compression artifacts, buck teeth, Big Mouth, noise, neck abnormality, long neck, sweat, plastic skin, doll-like skin, shiny skin, photorealistic, 3d render, plastic hair, synthetic hair, wig, unnatural hair, waxy skin, airbrushed, muted colors, pale colors, flat colors, desaturated, washed out, dull colors, grayscale, monochrome, sepia, overexposed, blown highlights, harsh lighting, oversaturated, fluorescent colors, neon colors, flat lighting, subsurface scattering error, messy lineart, sketch lines, noisy lines, rough sketch, artist:nameo_(judgemasterkou), artist:gaoo_(frpjx283), artist:kanon_(kurogane_knights), artist:mizuki_hitoshi,",
  parameters: {
    steps: 28,
    sampler: "k_dpmpp_2m_sde",
    scale: 7.5,
    cfg_rescale: 0,
  },
} as const;

export function novelAINegative(additional: string) {
  return [novelAIPreset.negative, additional.trim()].filter(Boolean).join(" ");
}
