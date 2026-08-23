# Example: Backend Module

Reference pattern for a feature module. Mirror this structure for new modules under `/modules`. See `engineering/backend.md` for the full rules this example follows.

```
/modules/users/
  users.module.ts
  users.controller.ts
  users.service.ts
  dto/create-user.dto.ts
  users.controller.spec.ts
  users.service.spec.ts
```

**dto/create-user.dto.ts**

```ts
import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
```

**users.service.ts**

```ts
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '@/prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateUserDto) {
    const hashedPassword = await bcrypt.hash(data.password, 10);
    return this.prisma.user.create({
      data: { email: data.email, password: hashedPassword },
      select: { id: true, email: true, createdAt: true },
    });
  }
}
```

**users.controller.ts**

```ts
import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';
import { CreateUserDto, createUserSchema } from './dto/create-user.dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new user' })
  @UsePipes(new ZodValidationPipe(createUserSchema))
  create(@Body() body: CreateUserDto) {
    return this.usersService.create(body);
  }
}
```

**users.module.ts**

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```
