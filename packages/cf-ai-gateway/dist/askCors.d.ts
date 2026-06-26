export type AskCorsOptions = {
    allowedOrigins: ReadonlySet<string> | readonly string[];
    allowedMethods?: string;
    allowedHeaders?: string;
    maxAgeSeconds?: string;
};
export declare function createAskCors(options: AskCorsOptions): {
    apply(request: Request, response: Response): Response;
    preflight(request: Request): Response;
    isAllowedOrigin(origin: string | undefined): boolean;
};
//# sourceMappingURL=askCors.d.ts.map