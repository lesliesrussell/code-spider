import { ExampleService } from './service'

export function execute(): string {
  const service = new ExampleService()
  return service.runTask()
}
