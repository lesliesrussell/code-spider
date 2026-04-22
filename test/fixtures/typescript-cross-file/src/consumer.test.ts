import { ExampleService } from './service'
import { execute } from './consumer'

export function buildSubject(): ExampleService {
  return new ExampleService()
}

export function runSpec(): string {
  return execute()
}
