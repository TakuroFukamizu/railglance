import { ImageRawDataUpdate } from '@evenrealities/even_hub_sdk';

export function patchImageCompressModeBug(): void {
  const cls = ImageRawDataUpdate as unknown as {
    toJson?: (model?: unknown) => Record<string, unknown>;
    __compressModePatched?: boolean;
  };

  if (
    typeof cls.toJson !== 'function' ||
    cls.__compressModePatched
  ) {
    return;
  }

  const originalToJson = cls.toJson.bind(ImageRawDataUpdate);

  cls.toJson = (model?: unknown): Record<string, unknown> => {
    const json = originalToJson(model);

    if (
      json &&
      typeof json === 'object' &&
      'compressMode' in json
    ) {
      delete json.compressMode;
    }

    return json;
  };

  cls.__compressModePatched = true;
  console.log('[SDK Patch] ImageRawDataUpdate.toJson compressMode removal patch applied successfully.');
}
