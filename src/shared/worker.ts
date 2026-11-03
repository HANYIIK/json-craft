import type { FormatOptions, KeySearchResult, ProcessingResult } from "./types";

export interface FormatRequest {
  kind: "format";
  id: number;
  raw: string;
  options: FormatOptions;
  recursiveUnescape?: boolean;
}

export interface KeySearchRequest {
  kind: "find-key";
  id: number;
  raw: string;
  key: string;
  options: FormatOptions;
}

export type WorkerRequest = FormatRequest | KeySearchRequest;

export interface FormatResponse {
  kind: "format";
  id: number;
  result: ProcessingResult;
}

export interface KeySearchResponse {
  kind: "find-key";
  id: number;
  result: KeySearchResult;
}

export type WorkerResponse = FormatResponse | KeySearchResponse;
