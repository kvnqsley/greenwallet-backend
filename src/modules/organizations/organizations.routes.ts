import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import { env } from "../../config/env";
import { requireMembership } from "../../common/org-access";
import {
  CreateOrganizationBody,
  InvitationParams,
  InvitationTokenParams,
  InviteBody,
  MemberParams,
  OrganizationParams,
  SearchOrganizationsQuery,
  UpdateMemberBody,
  UpdateOrganizationBody
} from "./organizations.schemas";
import {
  acceptInvitation,
  createOrganization,
  inviteMember,
  listInvitations,
  listMembers,
  listOrganizations,
  removeMember,
  revokeInvitation,
  searchOrganizations,
  updateMemberRole
} from "./organizations.service";

const isDev = env.NODE_ENV !== "production";

const organizationRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: Static<typeof CreateOrganizationBody> }>(
    "/organizations",
    { preHandler: app.authenticate, schema: { body: CreateOrganizationBody } },
    async (request, reply) => {
      const organization = await createOrganization(
        app.prisma,
        request.currentUser!.id,
        request.body
      );
      return reply.code(201).send({ organization, role: "OWNER" });
    }
  );

  app.get(
    "/organizations",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const memberships = await listOrganizations(
        app.prisma,
        request.currentUser!.id
      );
      return reply.send({
        organizations: memberships.map((membership) => ({
          role: membership.role,
          ...membership.organization
        }))
      });
    }
  );

  app.get<{ Querystring: Static<typeof SearchOrganizationsQuery> }>(
    "/organizations/search",
    {
      preHandler: app.authenticate,
      schema: { querystring: SearchOrganizationsQuery }
    },
    async (request, reply) => {
      const organizations = await searchOrganizations(
        app.prisma,
        request.query,
        request.user.sub
      );
      return reply.send({ organizations });
    }
  );


  app.get<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId",
    {
      preHandler: app.authenticate,
      schema: { params: OrganizationParams }
    },
    async (request, reply) => {
      const membership = await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId
      );
      return reply.send({
        organization: membership.organization,
        role: membership.role
      });
    }
  );

  app.patch<{
    Params: Static<typeof OrganizationParams>;
    Body: Static<typeof UpdateOrganizationBody>;
  }>(
    "/organizations/:organizationId",
    {
      preHandler: app.authenticate,
      schema: {
        params: OrganizationParams,
        body: UpdateOrganizationBody
      }
    },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER", "ADMIN"]
      );

      const organization = await app.prisma.organization.update({
        where: { id: request.params.organizationId },
        data: {
          ...(request.body.name !== undefined
            ? { name: request.body.name }
            : {}),
          ...(request.body.regNumber !== undefined
            ? { regNumber: request.body.regNumber }
            : {}),
          ...(request.body.roles !== undefined
            ? { roles: request.body.roles }
            : {})
        }
      });

      return reply.send({ organization });
    }
  );

  app.get<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId/members",
    { preHandler: app.authenticate, schema: { params: OrganizationParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId
      );
      const members = await listMembers(
        app.prisma,
        request.params.organizationId
      );
      return reply.send({ members });
    }
  );

  app.patch<{
    Params: Static<typeof MemberParams>;
    Body: Static<typeof UpdateMemberBody>;
  }>(
    "/organizations/:organizationId/members/:userId",
    {
      preHandler: app.authenticate,
      schema: { params: MemberParams, body: UpdateMemberBody }
    },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER"]
      );
      const membership = await updateMemberRole(
        app.prisma,
        request.params.organizationId,
        request.params.userId,
        request.body.role
      );
      return reply.send({ membership });
    }
  );

  app.delete<{ Params: Static<typeof MemberParams> }>(
    "/organizations/:organizationId/members/:userId",
    { preHandler: app.authenticate, schema: { params: MemberParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER"]
      );
      await removeMember(
        app.prisma,
        request.params.organizationId,
        request.params.userId
      );
      return reply.code(204).send();
    }
  );

  app.get<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId/invitations",
    { preHandler: app.authenticate, schema: { params: OrganizationParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER", "ADMIN"]
      );
      const invitations = await listInvitations(
        app.prisma,
        request.params.organizationId
      );
      return reply.send({ invitations });
    }
  );

  app.post<{
    Params: Static<typeof OrganizationParams>;
    Body: Static<typeof InviteBody>;
  }>(
    "/organizations/:organizationId/invitations",
    {
      preHandler: app.authenticate,
      schema: { params: OrganizationParams, body: InviteBody }
    },
    async (request, reply) => {
      const membership = await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER", "ADMIN"]
      );

      const { invitation, token } = await inviteMember(
        app.prisma,
        request.params.organizationId,
        request.currentUser!.id,
        request.body.email,
        request.body.role ?? "MEMBER"
      );

      const acceptUrl = `${env.APP_URL}/invitations/accept?token=${token}`;
      await app.mailer.send({
        to: invitation.email,
        subject: `You have been invited to ${membership.organization.name} on GreenWallet`,
        text: `Accept your invitation: ${acceptUrl}`
      });

      return reply.code(201).send({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt
        },
        ...(isDev ? { token } : {})
      });
    }
  );

  app.delete<{ Params: Static<typeof InvitationParams> }>(
    "/organizations/:organizationId/invitations/:invitationId",
    { preHandler: app.authenticate, schema: { params: InvitationParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER", "ADMIN"]
      );
      await revokeInvitation(
        app.prisma,
        request.params.organizationId,
        request.params.invitationId
      );
      return reply.code(204).send();
    }
  );

  app.post<{ Params: Static<typeof InvitationTokenParams> }>(
    "/invitations/:token/accept",
    { preHandler: app.authenticate, schema: { params: InvitationTokenParams } },
    async (request, reply) => {
      const result = await acceptInvitation(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.email,
        request.params.token
      );
      return reply.send({
        membership: result.membership,
        organization: result.organization
      });
    }
  );
};

export default organizationRoutes;
