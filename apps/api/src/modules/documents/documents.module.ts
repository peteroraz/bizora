import { Module } from "@nestjs/common";
import { DocumentNumberService } from "./document-number.service.js";

@Module({ providers: [DocumentNumberService], exports: [DocumentNumberService] })
export class DocumentsModule {}
