import { expect, it } from 'vitest'

import { createOrder } from '../src/orders/api.js'

it('returns 401 without a token', () => {
    expect(() => createOrder(undefined, ['a'])).toThrow('401')
})
