export function requireAuth(token: string | undefined): void {
    if (!token) throw new Error('401 unauthorized')
}
