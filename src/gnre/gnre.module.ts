import { Module } from '@nestjs/common';
import { GnreController } from './gnre.controller';
import { GnreService } from './gnre.service';

/** Emissão de GNRE da NF-e de saída pelo webservice (antes app desktop gnre-pa-app). */
@Module({
    controllers: [GnreController],
    providers: [GnreService],
})
export class GnreModule {}
