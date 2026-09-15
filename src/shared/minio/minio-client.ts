import * as Minio from 'minio';

let client: Minio.Client | null = null;

/**
 * Cliente MinIO do serviço (MINIO_ENDPOINT aceita host puro ou URL com
 * protocolo/porta; MINIO_PORT/MINIO_USE_SSL sobrepõem o que vier da URL).
 */
export function minioClient(): Minio.Client {
    if (client) return client;

    const rawEndpoint = String(process.env.MINIO_ENDPOINT || '').trim();
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    if (!rawEndpoint || !accessKey || !secretKey) {
        throw new Error(
            'Configuração MinIO incompleta: MINIO_ENDPOINT, MINIO_ACCESS_KEY e MINIO_SECRET_KEY são obrigatórios.',
        );
    }

    let endPoint = rawEndpoint;
    let port = Number(process.env.MINIO_PORT || 9000);
    let useSSL = String(process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true';

    if (/^https?:\/\//i.test(rawEndpoint)) {
        const url = new URL(rawEndpoint);
        endPoint = url.hostname;
        if (url.port) port = Number(url.port);
        else if (!process.env.MINIO_PORT) port = url.protocol === 'https:' ? 443 : 80;
        if (!process.env.MINIO_USE_SSL) useSSL = url.protocol === 'https:';
    }

    client = new Minio.Client({ endPoint, port, useSSL, accessKey, secretKey });
    return client;
}
