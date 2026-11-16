// An error whose message is safe to show to the shopper as-is (a plain sentence).
export class AnalyzeError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}
