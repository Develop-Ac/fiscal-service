import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Type, mixin } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/**
 * Formato do arquivo entregue ao `@UploadedFile()`. Mantém os mesmos campos que o
 * multer expunha no adapter Express (`buffer`, `originalname`, `mimetype`), para
 * que os controllers e services não precisem mudar.
 */
export interface UploadedFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    buffer: Buffer;
    size: number;
}

export interface FastifyFileInterceptorOptions {
    limits?: { fileSize?: number; files?: number; fields?: number };
}

type MultipartRequest = FastifyRequest & {
    isMultipart(): boolean;
    parts(options?: Record<string, unknown>): AsyncIterableIterator<any>;
};

/** Escreve por cima de propriedades que o Fastify define no protótipo (`file`). */
function definir(alvo: any, chave: string, valor: unknown) {
    Object.defineProperty(alvo, chave, { value: valor, writable: true, configurable: true, enumerable: true });
}

/**
 * Equivalente ao `FileInterceptor` do `@nestjs/platform-express`, porém sobre o
 * `@fastify/multipart`: consome as partes da requisição antes do handler, publica
 * o arquivo em `request.file` (lido pelo `@UploadedFile()`) e os campos de texto
 * em `request.body` (lido pelo `@Body()`).
 */
export function FileInterceptor(
    fieldName: string,
    options: FastifyFileInterceptorOptions = {},
): Type<NestInterceptor> {
    @Injectable()
    class FastifyFileInterceptor implements NestInterceptor {
        async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
            const request = context.switchToHttp().getRequest<MultipartRequest>();

            if (typeof request.isMultipart === 'function' && request.isMultipart()) {
                const campos: Record<string, unknown> = {};
                let enviado: UploadedFile | undefined;

                for await (const part of request.parts(options.limits ? { limits: options.limits } : {})) {
                    if (part.type === 'file') {
                        // Toda parte de arquivo precisa ser consumida, senão o iterador trava.
                        const buffer: Buffer = await part.toBuffer();
                        if (part.fieldname === fieldName && !enviado) {
                            enviado = {
                                fieldname: part.fieldname,
                                originalname: part.filename,
                                encoding: part.encoding,
                                mimetype: part.mimetype,
                                buffer,
                                size: buffer.length,
                            };
                        }
                    } else {
                        campos[part.fieldname] = part.value;
                    }
                }

                request.body = { ...((request.body as Record<string, unknown>) ?? {}), ...campos };
                definir(request, 'file', enviado);
            }

            return next.handle();
        }
    }

    return mixin(FastifyFileInterceptor);
}
