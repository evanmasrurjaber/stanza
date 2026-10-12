/** Parse req.body with a Zod schema; on failure the ZodError reaches errorHandler as INVALID_INPUT. */
export const validateBody = (schema) => (req, _res, next) => {
  req.body = schema.parse(req.body ?? {});
  next();
};
