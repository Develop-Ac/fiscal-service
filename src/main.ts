import { Logger, ValidationPipe, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as dotenv from 'dotenv';
import { AppModule } from './app.module';

/** Body/upload: 50 MB, o mesmo limite que o body-parser usava no Express. */
const LIMITE_BODY = 50 * 1024 * 1024;

// Permite serializar BigInt em respostas JSON (Postgres bigserial/bigint).
(BigInt.prototype as any).toJSON = function () {
    return Number(this);
};

async function bootstrap() {
    Logger.log('Starting bootstrap...', 'Bootstrap');
    try { dotenv.config(); } catch (_) { }
    const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter({ bodyLimit: LIMITE_BODY }),
        { bufferLogs: true },
    );

    await app.register(fastifyHelmet as any, {
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
    });

    // Upload de arquivos (equivalente ao multer). O limite por rota é ajustado
    // no FileInterceptor de cada controller.
    await app.register(fastifyMultipart as any, {
        limits: { fileSize: LIMITE_BODY },
    });

    const fastify = app.getHttpAdapter().getInstance();

    fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const url = request.url ?? '';
        if (!url.startsWith('/docs') && !url.startsWith('/docs-json')) return;

        const authHeader = request.headers.authorization;

        const user = 'admin';
        const password = 'Ac@2025acesso';

        if (!authHeader || !authHeader.startsWith('Basic ')) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
            return reply.status(401).send('Autenticação necessária');
        }

        const base64Credentials = authHeader.split(' ')[1];
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');

        const [inputUser, inputPassword] = credentials.split(':');

        if (inputUser !== user || inputPassword !== password) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger"');
            return reply.status(401).send('Usuário ou senha inválidos');
        }
    });

    const normalizeOrigin = (value?: string | null) => {
        if (!value) return '';
        return value.trim().replace(/^['\"]|['\"]$/g, '').replace(/\/$/, '').toLowerCase();
    };

    const configuredOrigins = (process.env.CORS_ORIGIN ?? '')
        .split(/[;,]/)
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean);

    const allowAllOrigins = configuredOrigins.includes('*');
    const allowedOrigins = new Set(configuredOrigins);

    Logger.log(`Raw CORS_ORIGIN env: '${process.env.CORS_ORIGIN}'`, 'Bootstrap');
    Logger.log(`CORS Origins configured: ${JSON.stringify(configuredOrigins)}`, 'Bootstrap');

    app.enableCors({
        origin: (origin, callback) => {
            // Requisicoes server-to-server ou tools sem Origin
            if (!origin) {
                return callback(null, true);
            }

            const normalizedRequestOrigin = normalizeOrigin(origin);
            if (allowAllOrigins || allowedOrigins.has(normalizedRequestOrigin)) {
                return callback(null, true);
            }

            Logger.warn(`CORS blocked origin: ${origin}`, 'Bootstrap');
            return callback(new Error(`Origin '${origin}' not allowed by CORS`), false);
        },
        credentials: true,
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    });

    app.setGlobalPrefix('api', {
        exclude: [{ path: 'metrics', method: RequestMethod.GET }],
    });

    const config = new DocumentBuilder()
        .setTitle('Calculadora ICMS ST API')
        .setDescription('API para cálculo de ICMS ST e geração de DANFE')
        .setVersion('1.0')
        .addTag('icms')
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    fastify.get('/', (request: FastifyRequest, reply: FastifyReply) => {
        const requesterIp =
            request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'unknown';
        Logger.log(`Requisicao de status recebida de ${requesterIp}`, 'Bootstrap');
        reply.status(200).send({
            status: 'online',
            message: 'O servidor está online e funcional',
            docs: '/api/docs',
            timestamp: new Date().toISOString()
        });
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: true },
        }),
    );

    const port = parseInt(process.env.PORT ?? '3000', 10);

    // Graceful shutdown
    process.on('SIGTERM', () => {
        Logger.log('Received SIGTERM signal. Closing http server...', 'Bootstrap');
        app.close();
    });

    await app.listen(port, '0.0.0.0');

    const url = await app.getUrl();

    Logger.log('------------------------------------------------------', 'Bootstrap');
    Logger.log(`🚀  Service ready and listening!`, 'Bootstrap');
    Logger.log(`------------------------------------------------------`, 'Bootstrap');
    Logger.log(`🟢  Local:   ${url}`, 'Bootstrap');
    Logger.log(`🟢  Network: http://0.0.0.0:${port}`, 'Bootstrap');
    Logger.log(`📄  Swagger: ${url}/api/docs`, 'Bootstrap');
    Logger.log(`------------------------------------------------------`, 'Bootstrap');
}

bootstrap().catch(err => {
    Logger.error('Fatal error during application bootstrap', err, 'Bootstrap');
    process.exit(1);
});
