export type BusinessSession = {
    businessToken: string;
    expiresAt: string;
    userId: string;
    im: {
        appId: string;
        apiBaseUrl: string;
        wsBaseUrl: string;
    };
};
let current: BusinessSession | null = null;
export function getBusinessSession() { return current; }
export function setBusinessSession(value: BusinessSession | null) { current = value; }
