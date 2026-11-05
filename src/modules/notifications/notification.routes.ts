import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  NotificationListQuery,
  NotificationParams,
  UpdateNotificationPreferencesBody
} from "./notification.schemas";
import {
  listNotificationPreferences,
  listNotifications,
  markNotificationRead,
  updateNotificationPreferences
} from "./notification.service";

const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Static<typeof NotificationListQuery> }>(
    "/notifications",
    {
      preHandler: app.authenticate,
      schema: { querystring: NotificationListQuery }
    },
    async (request, reply) => {
      const result = await listNotifications(
        app.prisma,
        request.currentUser!.id,
        request.query
      );
      return reply.send(result);
    }
  );

  app.patch<{ Params: Static<typeof NotificationParams> }>(
    "/notifications/:notificationId/read",
    { preHandler: app.authenticate, schema: { params: NotificationParams } },
    async (request, reply) => {
      const notification = await markNotificationRead(
        app.prisma,
        request.currentUser!.id,
        request.params.notificationId
      );
      return reply.send({ notification });
    }
  );

  app.get(
    "/notification-preferences",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const preferences = await listNotificationPreferences(
        app.prisma,
        request.currentUser!.id
      );
      return reply.send({ preferences });
    }
  );

  app.patch<{
    Body: Static<typeof UpdateNotificationPreferencesBody>;
  }>(
    "/notification-preferences",
    {
      preHandler: app.authenticate,
      schema: { body: UpdateNotificationPreferencesBody }
    },
    async (request, reply) => {
      const preferences = await updateNotificationPreferences(
        app.prisma,
        request.currentUser!.id,
        request.body.preferences
      );
      return reply.send({ preferences });
    }
  );
};

export default notificationRoutes;
