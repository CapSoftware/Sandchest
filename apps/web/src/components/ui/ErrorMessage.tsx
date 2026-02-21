interface ErrorMessageProps {
  message: string
  className?: string | undefined
  role?: string | undefined
}

export default function ErrorMessage({ message, className, role }: ErrorMessageProps) {
  return (
    <p className={className ?? 'dash-error'} role={role}>
      {message}
    </p>
  )
}
