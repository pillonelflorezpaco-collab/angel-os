export const CSRF: Record<string, string>;
export interface Outcome { kind: string; tone: "good" | "warn" | "bad" | "neutral"; text: string; approvalId?: string }
export function writeOutcome(httpStatus: number, body: any): Outcome;
export function approvalOutcome(httpStatus: number, body: any, decision: "approve" | "deny"): { tone: string; done: boolean; text: string };
export function progressLabel(progress: number | null | undefined): string;
export function countdown(expiresAtIso: string, nowMs: number): string;
export function sectionNotices(ctx: any): { section: string; kind: "withheld" | "unavailable"; text: string }[];
export function memoryLine(m: any): { label: string; text: string; guess: boolean };
export function learningLine(t: any): string;
export function riskLabel(risk: string): string;
export function formatWhen(iso: string, timeZone?: string): string;
export const GRADES: { value: number; label: string }[];
export function listFrom(httpStatus: number, body: any): any[] | null;
