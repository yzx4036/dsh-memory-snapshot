export declare const name = "dsh-memory-snapshot";
export declare const inject: string[];
export interface Config {
    files: string[];
    maxBytes: number;
    totalMaxBytes: number;
    order: number;
    marker: string;
}
type StdResult = {
    value: Config;
} | {
    issues: {
        message: string;
        path: (string | number)[];
    }[];
};
export declare const Config: {
    '~standard': {
        version: 1;
        vendor: string;
        validate(value: unknown): StdResult;
    };
};
export declare function apply(ctx: {
    systemPrompt: {
        section(opt: {
            name: string;
            order: number;
            text: string | (() => string);
        }): void;
    };
}, config: Config): void;
export {};
