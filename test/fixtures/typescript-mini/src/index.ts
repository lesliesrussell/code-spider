export class ExampleService {
  runTask(): string {
    return helper()
  }
}

export function helper(): string {
  return 'ok'
}

export function execute(): string {
  const service = new ExampleService()
  return service.runTask()
}
