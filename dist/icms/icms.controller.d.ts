import { StreamableFile } from '@nestjs/common';
import { IcmsService } from './icms.service';
import { Response } from 'express';
import { FiscalConferenceRequestDto } from './dto/fiscal-conference.dto';
export declare class IcmsController {
    private readonly service;
    constructor(service: IcmsService);
    getInvoices(start?: string, end?: string): Promise<{
        CHAVE_NFE: string;
        NOME_EMITENTE: string;
        CPF_CNPJ_EMITENTE: string;
        DATA_EMISSAO: Date;
        DT_ENTRADA: Date;
        VALOR_TOTAL: number;
        STATUS_ERP: string;
        TIPO_OPERACAO: number;
        TIPO_OPERACAO_DESC: string;
        XML_COMPLETO: string;
        XML_TIPO: "COMPLETO" | "RESUMO" | "SEM_XML";
        TIPO_IMPOSTO: string;
        RASTREIO_SITUACAO: string;
    }[]>;
    importXmlInvoices(body: {
        xmls: string[];
    }): Promise<any[]>;
    getInvoiceByKey(chaveNfe: string): Promise<{
        EMPRESA: number;
        CHAVE_NFE: string;
        NOME_EMITENTE: string;
        CPF_CNPJ_EMITENTE: string;
        DATA_EMISSAO: Date;
        DT_ENTRADA: Date;
        VALOR_TOTAL: number;
        STATUS_ERP: string;
        TIPO_OPERACAO: number;
        TIPO_OPERACAO_DESC: string;
        XML_COMPLETO: string;
        XML_TIPO: "COMPLETO" | "RESUMO" | "SEM_XML";
        TIPO_IMPOSTO: string;
    }>;
    syncLaunchedInvoices(): Promise<{
        jobId: `${string}-${string}-${string}-${string}-${string}`;
    }>;
    getSyncLaunchedInvoicesStatus(jobId: string): Promise<{
        jobId: string;
        status: "running" | "completed" | "failed";
        totalEncontradas: number;
        processadas: number;
        inseridas: number;
        ignoradas: number;
        progresso: number;
        logs: string[];
        startedAt: string;
        completedAt?: string;
        errorMessage?: string;
    }>;
    startXmlNormalization(body?: {
        batchSize?: number;
    }): Promise<{
        jobId: `${string}-${string}-${string}-${string}-${string}`;
        batchSize: number;
    }>;
    getXmlNormalizationStatus(jobId: string): Promise<{
        jobId: string;
        status: "running" | "completed" | "failed";
        total: number;
        processadas: number;
        normalizadas: number;
        ignoradas: number;
        erros: number;
        progresso: number;
        logs: string[];
        startedAt: string;
        completedAt?: string;
        errorMessage?: string;
    }>;
    calculate(body: {
        xmls: string[];
    }): Promise<any[]>;
    savePaymentStatus(body: any): Promise<any[] | {
        fiscalConference: any;
        chave_nfe: string;
        data_pagamento: Date;
        valor: number;
        observacoes: string;
    }>;
    previewFiscalConference(body: FiscalConferenceRequestDto): Promise<{
        notas: any[];
    }>;
    persistFiscalConference(body: FiscalConferenceRequestDto): Promise<{
        notas: any[];
    }>;
    listAuditoria(q?: string, emitente?: string, escopo?: string, status?: string, dtInicio?: string, dtFim?: string, page?: string, pageSize?: string): Promise<{
        page: number;
        pageSize: number;
        total: any;
        items: {
            chaveNfe: any;
            numero: string;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            status: any;
            auditadoEm: any;
            totalErros: any;
            temRessalva: boolean;
        }[];
    }>;
    reconferirPeriodo(q?: string, emitente?: string, escopo?: string, status?: string, dtInicio?: string, dtFim?: string): Promise<{
        total: number;
        ok: number;
        divergente: number;
    }>;
    exportarXmlAuditoria(q: string | undefined, emitente: string | undefined, escopo: string | undefined, status: string | undefined, dtInicio: string | undefined, dtFim: string | undefined, res: Response): Promise<StreamableFile>;
    getAuditoria(chaveNfe: string): Promise<{
        header: {
            status: any;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            mensagem: string;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: any[];
    } | {
        header: {
            status: string;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            temRessalva: boolean;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: {
            nItem: number;
            proCodigo: string;
            descricao: string;
            imposto: string;
            destinacao: string;
            totalErros: number;
            ressalvado: boolean;
            ressalvaMotivo: string;
            checks: {
                campo: string;
                esperado: string | null;
                encontrado: string | null;
                ok: boolean;
                mensagem?: string;
            }[];
        }[];
    }>;
    adicionarRessalva(chaveNfe: string, body: {
        nItem?: number;
        motivo?: string;
        usuario?: string;
    }): Promise<{
        header: {
            status: any;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            mensagem: string;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: any[];
    } | {
        header: {
            status: string;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            temRessalva: boolean;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: {
            nItem: number;
            proCodigo: string;
            descricao: string;
            imposto: string;
            destinacao: string;
            totalErros: number;
            ressalvado: boolean;
            ressalvaMotivo: string;
            checks: {
                campo: string;
                esperado: string | null;
                encontrado: string | null;
                ok: boolean;
                mensagem?: string;
            }[];
        }[];
    }>;
    removerRessalva(chaveNfe: string, nItem: string): Promise<{
        header: {
            status: any;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            mensagem: string;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: any[];
    } | {
        header: {
            status: string;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            temRessalva: boolean;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: {
            nItem: number;
            proCodigo: string;
            descricao: string;
            imposto: string;
            destinacao: string;
            totalErros: number;
            ressalvado: boolean;
            ressalvaMotivo: string;
            checks: {
                campo: string;
                esperado: string | null;
                encontrado: string | null;
                ok: boolean;
                mensagem?: string;
            }[];
        }[];
    }>;
    reconferirAuditoria(chaveNfe: string): Promise<{
        header: {
            status: any;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            mensagem: string;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: any[];
    } | {
        header: {
            status: string;
            totalErros: number;
            semConferencia: boolean;
            naoAuditavel: boolean;
            temRessalva: boolean;
            chaveNfe: any;
            numero: string;
            serie: any;
            emitente: any;
            cnpj: any;
            uf: string;
            dentroEstado: boolean;
            dataEmissao: any;
            dtEntrada: any;
            valorTotal: number;
            statusErp: any;
            auditadoEm: any;
        };
        cabecalho: any[];
        itens: {
            nItem: number;
            proCodigo: string;
            descricao: string;
            imposto: string;
            destinacao: string;
            totalErros: number;
            ressalvado: boolean;
            ressalvaMotivo: string;
            checks: {
                campo: string;
                esperado: string | null;
                encontrado: string | null;
                ok: boolean;
                mensagem?: string;
            }[];
        }[];
    }>;
    enviarAlertaAuditoria(chaveNfe: string): Promise<{
        enviado: boolean;
        totalErros: number;
        status: "OK" | "DIVERGENTE";
        motivo?: string;
    }>;
    getFiscalRegras(): Promise<{
        regras: any[];
        opf: any[];
        origem: any[];
        cfops: any[];
    }>;
    saveFiscalRegras(body: {
        regras?: any[];
        opf?: any[];
        origem?: any[];
    }): Promise<{
        regras: any[];
        opf: any[];
        origem: any[];
        cfops: any[];
    }>;
    getPaymentStatus(): Promise<Record<string, {
        status: string;
        valor: number;
        tipo_imposto?: string;
        guiaGerada?: boolean;
        guiaPath?: string;
        status_conferencia_produtos?: "OK" | "ERRO" | "SEM_RELACIONAMENTO" | "PENDENTE";
    }>>;
    getPaymentStatusByKey(chaveNfe: string): Promise<{
        chaveNfe: string;
        status: string;
        valor: number;
        tipo_imposto: string;
        data_pagamento: Date;
        status_conferencia_produtos: "OK" | "ERRO" | "SEM_RELACIONAMENTO" | "PENDENTE";
        itens_conciliacao: {
            n_item: any;
            cod_prod_fornecedor: any;
            pro_codigo: any;
            destinacao_mercadoria: any;
            imposto_escolhido: any;
            possui_icms_st: any;
            possui_difal: any;
            ncm_xml: any;
            cst_nota: any;
            divergencias_json: string[];
            status_conferencia: any;
            updated_at: any;
        }[];
        guia_gerada: boolean;
        guia: {
            bucket: any;
            path: any;
            original_file_name: any;
            numero_documento: any;
            data_vencimento: any;
            valor: any;
            fe_cte: any;
            numero_nf_extraido: any;
            fe_cte_confere: any;
            aviso: any;
            uploaded_at: any;
        };
    }>;
    uploadGuiaByNfe(chaveNfe: string, file?: any): Promise<{
        chaveNfe: string;
        guia_gerada: boolean;
        bucket: string;
        path: string;
        original_file_name: string;
        numero_documento: string;
        data_vencimento: Date;
        valor: number;
        fe_cte: string;
        numero_nf_extraido: string;
        fe_cte_confere: boolean;
        aviso: string;
    }>;
    getGuiaByNfe(chaveNfe: string): Promise<{
        chaveNfe: any;
        guia_gerada: boolean;
        bucket: any;
        path: any;
        original_file_name: string;
        numero_documento: any;
        data_vencimento: any;
        valor: any;
        fe_cte: any;
        numero_nf_extraido: any;
        fe_cte_confere: any;
        aviso: any;
        uploaded_at: any;
        updated_at: any;
    }>;
    downloadGuiaByNfe(chaveNfe: string, res: Response): Promise<StreamableFile>;
    getGuiasEscaneadas(chaveNfe: string): Promise<{
        count: number;
        guias: {
            id: number;
            data_documento: string;
            descricao: any;
            nome_arquivo: any;
            tamanho_bytes: number;
            nf_numero: any;
            chave_nfe: any;
            fornecedor_nome: any;
            fornecedor_cnpj: any;
            for_codigo: number;
            criado_em: any;
            vinculo: "chave" | "numero_cnpj";
        }[];
    }>;
    downloadGuiaEscaneada(id: string, res: Response): Promise<StreamableFile>;
    private cabecalhoPdf;
    removeGuiaByNfe(chaveNfe: string): Promise<{
        success: boolean;
        chaveNfe: string;
    }>;
    generateDanfe(body: {
        xml: string;
    }, res: Response): Promise<StreamableFile>;
    generateDanfeBatch(body: {
        invoices: {
            xml: string;
            chave: string;
        }[];
    }, res: Response): Promise<StreamableFile>;
}
