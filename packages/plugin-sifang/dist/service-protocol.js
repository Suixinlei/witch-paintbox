export const SERVICE_VERSION = 3;
export const PACKET_TYPE = 'application/vnd.witch-paintbox.v1';
const METADATA_LIMIT = 16 * 1024 * 1024;
/** A length-prefixed JSON manifest followed by raw Blob bytes, in a single HTTP body. */
export function packet(value, blobs = []) {
    const metadata = new TextEncoder().encode(JSON.stringify({
        value, blobs: blobs.map(blob => ({ size: blob.size, type: blob.type })),
    }));
    if (metadata.byteLength > METADATA_LIMIT)
        throw new Error('独立服务数据过大。');
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, metadata.byteLength);
    return new Blob([head, metadata, ...blobs], { type: PACKET_TYPE });
}
export async function unpack(body) {
    const invalid = () => new Error('独立服务返回的数据格式无效。');
    if (body.size < 4)
        throw invalid();
    const length = new DataView(await body.slice(0, 4).arrayBuffer()).getUint32(0);
    if (!length || length > METADATA_LIMIT || 4 + length > body.size)
        throw invalid();
    const manifest = JSON.parse(await body.slice(4, 4 + length).text());
    if (!manifest || manifest.value === undefined || !Array.isArray(manifest.blobs))
        throw invalid();
    let offset = 4 + length;
    const blobs = manifest.blobs.map(part => {
        if (!part || !Number.isSafeInteger(part.size) || part.size < 0 || offset + part.size > body.size
            || !['image/png', 'image/jpeg', 'image/webp', ''].includes(part.type))
            throw invalid();
        const blob = body.slice(offset, offset + part.size, part.type);
        offset += part.size;
        return blob;
    });
    if (offset !== body.size)
        throw invalid();
    return { value: manifest.value, blobs };
}
