import type { KeyAlignmentResult } from "../core/json/compare";
import type {
  FormatOptions,
  Indent,
  KeySearchResult,
  ProcessingResult,
} from "./types";

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

export interface KeyAlignmentRequest {
  kind: "align-keys";
  id: number;
  left: string;
  right: string;
  indent: Indent;
}

export type WorkerRequest =
  FormatRequest | KeySearchRequest | KeyAlignmentRequest;

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

export interface KeyAlignmentResponse {
  kind: "align-keys";
  id: number;
  result: KeyAlignmentResult;
}

export type WorkerResponse =
  FormatResponse | KeySearchResponse | KeyAlignmentResponse;
