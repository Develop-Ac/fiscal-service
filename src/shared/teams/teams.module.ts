import { Module } from '@nestjs/common';
import { TeamsGraphClient } from './teams-graph.client';
import { TeamsController } from './teams.controller';

@Module({
    controllers: [TeamsController],
    providers: [TeamsGraphClient],
    exports: [TeamsGraphClient],
})
export class TeamsModule {}
