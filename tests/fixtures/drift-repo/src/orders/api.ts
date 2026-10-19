import { requireAuth } from '../auth/middleware.js'

export function createOrder(token: string | undefined, items: string[]): { id: string; items: string[] } {
    requireAuth(token)
    return { id: 'order-1', items }
}
