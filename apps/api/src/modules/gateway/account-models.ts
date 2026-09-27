// Python AgentCredential.supported_models includes an explicitly configured default.
// An empty declaration is never a wildcard; discovery does not mutate this configuration.
export function supportedModels(account: {
  supported_models: readonly string[]
  default_model: string
}): string[] {
  const models = [...account.supported_models]
  if (account.default_model && !models.includes(account.default_model))
    models.unshift(account.default_model)
  return models
}

export function supportsModel(
  account: Parameters<typeof supportedModels>[0],
  model: string,
): boolean {
  return supportedModels(account).includes(model)
}
