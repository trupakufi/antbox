import { AntboxError } from "../../shared/antbox_error.ts";

export class InvalidFullnameFormatError extends AntboxError {
  static ERROR_CODE = "InvalidFullnameFormatError";

  constructor(email: string) {
    super(
      InvalidFullnameFormatError.ERROR_CODE,
      `Invalid Fullname Format: ${email}`
    );
  }
}
