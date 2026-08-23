# Example: Tests

Reference patterns for both layers. See `engineering/testing.md` for the philosophy behind what gets tested.

## Frontend: component test (Jest + React Testing Library)

```tsx
import { render, screen } from '@testing-library/react';
import { Toast } from './Toast';

test('renders the message and correct variant class', () => {
  render(<Toast variant="success" message="Saved" />);
  const toast = screen.getByRole('status');
  expect(toast).toHaveTextContent('Saved');
  expect(toast.className).toMatch(/success/);
});
```

## Backend: service unit test (Jest, mocked Prisma)

```ts
import { Test } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '@/prisma/prisma.service';

describe('UsersService', () => {
  let service: UsersService;
  const prismaMock = { user: { create: jest.fn() } };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get(UsersService);
  });

  it('hashes the password before storing the user', async () => {
    prismaMock.user.create.mockResolvedValue({ id: '1', email: 'a@b.com' });

    await service.create({ email: 'a@b.com', password: 'secret123' });

    const callArgs = prismaMock.user.create.mock.calls[0][0];
    expect(callArgs.data.password).not.toBe('secret123');
  });
});
```

## Backend: controller integration test (auth-protected route)

```ts
it('rejects the request without a valid token', async () => {
  const response = await request(app.getHttpServer()).get('/users/me');
  expect(response.status).toBe(401);
});
```
