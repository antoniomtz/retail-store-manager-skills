final class SimulationException extends Exception {
    final int status;
    final String code;

    SimulationException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
