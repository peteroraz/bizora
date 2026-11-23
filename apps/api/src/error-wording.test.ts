import "reflect-metadata";
import { BadRequestException, ForbiddenException, HttpException, NotFoundException, ParseUUIDPipe } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, ErrorEnvelopeFilter, plainMessage } from "./common/errors.js";

/** Pilot readiness, item 21: people see what happened and what to do, never a framework's own words. */
describe("error wording", () => {
  function shown(exception: unknown) {
    let body: { error: { code: string; message: string } } | null = null;
    let status = 0;
    const response = {
      status: (code: number) => {
        status = code;
        return response;
      },
      json: (value: typeof body) => {
        body = value;
        return response;
      },
    };
    const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ correlationId: "a1b2c3d4-e5f6", method: "GET", url: "/x", headers: {} }) }) };
    new ErrorEnvelopeFilter({ error: () => undefined } as never).catch(exception, host as never);
    return { status, ...body!.error };
  }

  it("replaces framework messages with plain words", async () => {
    expect(shown(new ThrottlerException())).toMatchObject({ status: 429, code: "RATE_LIMITED", message: "Too many tries. Wait a minute, then try again." });
    expect(shown(new ForbiddenException())).toMatchObject({ status: 403, message: "You do not have permission to do this. Ask the business owner." });
    expect(shown(new NotFoundException("Cannot GET /api/v1/nothing"))).toMatchObject({ status: 404, message: "This could not be found. It may have been removed." });
    const uuid = await new ParseUUIDPipe().transform("nope", { type: "param" }).catch((error: unknown) => error);
    expect(shown(uuid)).toMatchObject({ status: 400, message: "Some details are missing or not right. Check them and try again." });
    expect(shown(z.object({ name: z.string() }).safeParse({}).error)).toMatchObject({ status: 400, code: "VALIDATION_ERROR", message: "Some details are missing or not right. Check them and try again." });
  });

  it("keeps messages written for people", () => {
    expect(shown(new ApiError("PLAN_LIMIT", "Your plan allows 1 shop(s). Upgrade your plan to add another shop.", 402)).message).toMatch(/^Your plan allows/);
    expect(shown(new BadRequestException("Choose a shop first.")).message).toBe("Choose a shop first.");
    expect(plainMessage(409, "Conflict")).toBe("This was changed by someone else. Refresh and try again.");
  });

  it("gives a short code to tell support when something breaks on our side", () => {
    const broken = shown(new Error("database went away"));
    expect(broken).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(broken.message).toBe("Something went wrong on our side. Try again in a moment. If it keeps happening, tell Bizora support this code: a1b2c3d4.");
    expect(broken.message).not.toContain("database");
    expect(shown(new HttpException("Bad Gateway", 502)).message).toMatch(/^Something went wrong on our side/);
  });
});
