export default async function (input) {
  const name = input.name ?? 'World';
  return { success: true, result: `Hello, ${name}!` };
}
