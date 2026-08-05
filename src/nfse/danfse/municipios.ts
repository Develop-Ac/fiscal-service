import * as fs from 'fs';
import * as path from 'path';

/**
 * Tabela IBGE de municípios, para traduzir os códigos que o XML da NFS-e
 * nacional usa em `cMun`/`cLocPrestacao`.
 *
 * A tabela vem de um asset ao lado do código (`assets/Municipios.xml`, copiado
 * para o `dist` pelo nest-cli). Carrega uma vez e fica em memória; se o arquivo
 * faltar, o código cru é exibido — documento fiscal não pode mostrar nome errado,
 * mas mostrar o código é honesto.
 */
let tabela: Map<string, string> | null = null;

function carregar(): Map<string, string> {
    if (tabela) return tabela;
    tabela = new Map<string, string>();
    try {
        // <Estado><Sigla>MT</Sigla>…<Municipio><Nome>X</Nome><CodigoIBGE>N</CodigoIBGE>
        const xml = fs.readFileSync(path.join(__dirname, 'assets', 'Municipios.xml'), 'utf8');
        for (const bloco of xml.split('<Estado>').slice(1)) {
            const uf = (/<Sigla>([^<]*)<\/Sigla>/.exec(bloco) || [, ''])[1].trim();
            const re = /<Nome>([^<]*)<\/Nome>\s*<CodigoIBGE>(\d+)<\/CodigoIBGE>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(bloco))) {
                tabela.set(m[2], uf ? `${m[1].trim()}/${uf}` : m[1].trim());
            }
        }
    } catch {
        /* sem tabela: cai no código cru */
    }
    return tabela;
}

/** "SORRISO/MT" a partir do código IBGE; cai no `fallback` e depois no código. */
export function municipio(ibge: unknown, fallback?: string): string {
    const cod = String(ibge ?? '').replace(/\D/g, '');
    return carregar().get(cod) || fallback || cod;
}

/** Logo "NFS-e" do padrão nacional, em base64 para embutir no PDF. */
let logo: Buffer | null | undefined;
export function logoNfse(): Buffer | null {
    if (logo !== undefined) return logo;
    try {
        logo = fs.readFileSync(path.join(__dirname, 'assets', 'logo-nfse.png'));
    } catch {
        logo = null;
    }
    return logo;
}
