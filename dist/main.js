"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const bodyParser = __importStar(require("body-parser"));
const helmet_1 = __importDefault(require("helmet"));
const dotenv = __importStar(require("dotenv"));
const app_module_1 = require("./app.module");
BigInt.prototype.toJSON = function () {
    return Number(this);
};
async function bootstrap() {
    var _a, _b;
    common_1.Logger.log('Starting bootstrap...', 'Bootstrap');
    try {
        dotenv.config();
    }
    catch (_) { }
    const app = await core_1.NestFactory.create(app_module_1.AppModule, { bufferLogs: true });
    app.use((0, helmet_1.default)({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
    }));
    app.use(['/docs', '/docs-json'], (req, res, next) => {
        const authHeader = req.headers.authorization;
        const user = 'admin';
        const password = 'Ac@2025acesso';
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Swagger"');
            return res.status(401).send('Autenticação necessária');
        }
        const base64Credentials = authHeader.split(' ')[1];
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const [inputUser, inputPassword] = credentials.split(':');
        if (inputUser !== user || inputPassword !== password) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Swagger"');
            return res.status(401).send('Usuário ou senha inválidos');
        }
        next();
    });
    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    const normalizeOrigin = (value) => {
        if (!value)
            return '';
        return value.trim().replace(/^['\"]|['\"]$/g, '').replace(/\/$/, '').toLowerCase();
    };
    const configuredOrigins = ((_a = process.env.CORS_ORIGIN) !== null && _a !== void 0 ? _a : '')
        .split(/[;,]/)
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean);
    const allowAllOrigins = configuredOrigins.includes('*');
    const allowedOrigins = new Set(configuredOrigins);
    common_1.Logger.log(`Raw CORS_ORIGIN env: '${process.env.CORS_ORIGIN}'`, 'Bootstrap');
    common_1.Logger.log(`CORS Origins configured: ${JSON.stringify(configuredOrigins)}`, 'Bootstrap');
    app.enableCors({
        origin: (origin, callback) => {
            if (!origin) {
                return callback(null, true);
            }
            const normalizedRequestOrigin = normalizeOrigin(origin);
            if (allowAllOrigins || allowedOrigins.has(normalizedRequestOrigin)) {
                return callback(null, true);
            }
            common_1.Logger.warn(`CORS blocked origin: ${origin}`, 'Bootstrap');
            return callback(new Error(`Origin '${origin}' not allowed by CORS`), false);
        },
        credentials: true,
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    });
    app.setGlobalPrefix('api', {
        exclude: [{ path: 'metrics', method: common_1.RequestMethod.GET }],
    });
    const config = new swagger_1.DocumentBuilder()
        .setTitle('Calculadora ICMS ST API')
        .setDescription('API para cálculo de ICMS ST e geração de DANFE')
        .setVersion('1.0')
        .addTag('icms')
        .build();
    const document = swagger_1.SwaggerModule.createDocument(app, config);
    swagger_1.SwaggerModule.setup('api/docs', app, document);
    const httpServer = app.getHttpAdapter().getInstance();
    httpServer.get('/', (req, res) => {
        var _a, _b, _c, _d, _e;
        const requesterIp = (_e = (_c = (_a = req.headers['x-forwarded-for']) !== null && _a !== void 0 ? _a : (_b = req.socket) === null || _b === void 0 ? void 0 : _b.remoteAddress) !== null && _c !== void 0 ? _c : (_d = req.connection) === null || _d === void 0 ? void 0 : _d.remoteAddress) !== null && _e !== void 0 ? _e : 'unknown';
        common_1.Logger.log(`Requisicao de status recebida de ${requesterIp}`, 'Bootstrap');
        res.status(200).json({
            status: 'online',
            message: 'O servidor está online e funcional',
            docs: '/api/docs',
            timestamp: new Date().toISOString()
        });
    });
    app.useGlobalPipes(new common_1.ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
    }));
    const port = parseInt((_b = process.env.PORT) !== null && _b !== void 0 ? _b : '3000', 10);
    process.on('SIGTERM', () => {
        common_1.Logger.log('Received SIGTERM signal. Closing http server...', 'Bootstrap');
        app.close();
    });
    await app.listen(port, '0.0.0.0');
    const url = await app.getUrl();
    common_1.Logger.log('------------------------------------------------------', 'Bootstrap');
    common_1.Logger.log(`🚀  Service ready and listening!`, 'Bootstrap');
    common_1.Logger.log(`------------------------------------------------------`, 'Bootstrap');
    common_1.Logger.log(`🟢  Local:   ${url}`, 'Bootstrap');
    common_1.Logger.log(`🟢  Network: http://0.0.0.0:${port}`, 'Bootstrap');
    common_1.Logger.log(`📄  Swagger: ${url}/api/docs`, 'Bootstrap');
    common_1.Logger.log(`------------------------------------------------------`, 'Bootstrap');
}
bootstrap().catch(err => {
    common_1.Logger.error('Fatal error during application bootstrap', err, 'Bootstrap');
    process.exit(1);
});
//# sourceMappingURL=main.js.map