import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Static } from "@sinclair/typebox";
import { env } from "../../config/env";
import { badRequest } from "../../common/errors";
import {
  ForgotPasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  ResetPasswordBody,
  VerifyEmailBody
} from "./auth.schemas";
import {
  authenticateCredentials,
  createEmailVerificationToken,
  createPasswordResetToken,
  createRefreshToken,
  registerAccount,
  resetPassword,
  revokeRefreshToken,
  rotateRefreshToken,
  toPublicUser,
  verifyEmail
} from "./auth.service";

const isDev = env.NODE_ENV !== "production";

const authRateLimit = {
  config: {
    rateLimit: {
      max: env.AUTH_RATE_LIMIT_MAX,
      timeWindow: env.AUTH_RATE_LIMIT_WINDOW
    }
  }
};

const authRoutes: FastifyPluginAsync = async (app) => {
  const meta = (request: FastifyRequest) => {
    const userAgent = request.headers["user-agent"];
    return {
      ip: request.ip,
      userAgent: typeof userAgent === "string" ? userAgent : undefined
    };
  };

  app.post<{ Body: Static<typeof RegisterBody> }>(
    "/register",
    { ...authRateLimit, schema: { body: RegisterBody } },
    async (request, reply) => {
      const { user, organization, verificationToken } = await registerAccount(
        app.prisma,
        request.body
      );

      const accessToken = app.jwt.sign({
        sub: user.id,
        role: user.platformRole
      });
      const refresh = await createRefreshToken(
        app.prisma,
        user.id,
        meta(request)
      );

      const verificationUrl = `${env.APP_URL}/verify-email?token=${verificationToken}`;
      await app.mailer.send({
        to: user.email,
        subject: "Verify your GreenWallet email",
        text: `Welcome to GreenWallet. Verify your email: ${verificationUrl}`
      });

      return reply.code(201).send({
        user: toPublicUser(user),
        organization,
        accessToken,
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt,
        ...(isDev ? { verificationToken } : {})
      });
    }
  );

  app.post<{ Body: Static<typeof LoginBody> }>(
    "/login",
    { ...authRateLimit, schema: { body: LoginBody } },
    async (request, reply) => {
      const user = await authenticateCredentials(
        app.prisma,
        request.body.email,
        request.body.password
      );

      const accessToken = app.jwt.sign({
        sub: user.id,
        role: user.platformRole
      });
      const refresh = await createRefreshToken(
        app.prisma,
        user.id,
        meta(request)
      );

      return reply.send({
        user: toPublicUser(user),
        accessToken,
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt
      });
    }
  );

  app.post<{ Body: Static<typeof RefreshBody> }>(
    "/refresh",
    { ...authRateLimit, schema: { body: RefreshBody } },
    async (request, reply) => {
      const result = await rotateRefreshToken(
        app.prisma,
        request.body.refreshToken,
        meta(request)
      );

      const accessToken = app.jwt.sign({
        sub: result.user.id,
        role: result.user.platformRole
      });

      return reply.send({
        user: toPublicUser(result.user),
        accessToken,
        refreshToken: result.refreshToken,
        refreshExpiresAt: result.refreshExpiresAt
      });
    }
  );

  app.post<{ Body: Static<typeof RefreshBody> }>(
    "/logout",
    { schema: { body: RefreshBody } },
    async (request, reply) => {
      await revokeRefreshToken(app.prisma, request.body.refreshToken);
      return reply.code(204).send();
    }
  );

  app.post<{ Body: Static<typeof VerifyEmailBody> }>(
    "/verify-email",
    { ...authRateLimit, schema: { body: VerifyEmailBody } },
    async (request, reply) => {
      const user = await verifyEmail(app.prisma, request.body.token);
      return reply.send({ user: toPublicUser(user) });
    }
  );

  app.post(
    "/resend-verification",
    { ...authRateLimit, preHandler: app.authenticate },
    async (request, reply) => {
      const userId = request.currentUser!.id;
      const user = await app.prisma.user.findUnique({ where: { id: userId } });

      if (!user) {
        throw badRequest("User not found");
      }
      if (user.emailVerifiedAt) {
        throw badRequest("Email is already verified");
      }

      const token = await createEmailVerificationToken(app.prisma, user.id);
      const verificationUrl = `${env.APP_URL}/verify-email?token=${token}`;
      await app.mailer.send({
        to: user.email,
        subject: "Verify your GreenWallet email",
        text: `Verify your email: ${verificationUrl}`
      });

      return reply.send({
        message: "Verification email sent",
        ...(isDev ? { verificationToken: token } : {})
      });
    }
  );

  app.post<{ Body: Static<typeof ForgotPasswordBody> }>(
    "/forgot-password",
    { ...authRateLimit, schema: { body: ForgotPasswordBody } },
    async (request, reply) => {
      const token = await createPasswordResetToken(
        app.prisma,
        request.body.email
      );

      if (token) {
        const resetUrl = `${env.APP_URL}/reset-password?token=${token}`;
        await app.mailer.send({
          to: request.body.email,
          subject: "Reset your GreenWallet password",
          text: `Reset your password: ${resetUrl}`
        });
      }

      return reply.send({
        message:
          "If an account with that email exists, a password reset email has been sent",
        ...(isDev && token ? { resetToken: token } : {})
      });
    }
  );

  app.post<{ Body: Static<typeof ResetPasswordBody> }>(
    "/reset-password",
    { ...authRateLimit, schema: { body: ResetPasswordBody } },
    async (request, reply) => {
      await resetPassword(
        app.prisma,
        request.body.token,
        request.body.password
      );
      return reply.send({ message: "Password has been reset" });
    }
  );
};

export default authRoutes;
