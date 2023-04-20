import { left, right } from "../../shared/either.ts";
import { RegexSpec } from "../../shared/regex_spec.ts";
import {
  AndSpecification,
  ValidationResult,
  specFn,
} from "../../shared/specification.ts";
import { ValidationError } from "../../shared/validation_error.ts";
import { InvalidEmailFormatError } from "./invalid_email_format_error.ts";
import { InvalidFullnameFormatError } from "./invalid_fullname_format_error.ts";
import { User } from "./user.ts";

export class UserSpec extends AndSpecification<User> {
  constructor() {
    super(specFn(fullnameSpec), specFn(emailSpec));
  }
}

function emailSpec(u: User): ValidationResult {
  const EMAIL_REGEX =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  const spec = new RegexSpec(EMAIL_REGEX);

  if (spec.isSatisfiedBy(u.email).isLeft()) {
    return left(ValidationError.from(new InvalidEmailFormatError(u.email)));
  }

  return right(true);
}

function fullnameSpec(u: User): ValidationResult {
  if (u.fullname.length < 3) {
    return left(
      ValidationError.from(new InvalidFullnameFormatError(u.fullname))
    );
  }

  return right(true);
}
